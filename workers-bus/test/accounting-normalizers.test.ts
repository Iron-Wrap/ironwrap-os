// Slice S3, contract conformance. docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 9.
//
// "A checked-in shape descriptor per entity, asserted two ways: every fixture validates against it,
// and the normalizer reads no field absent from it."
//
// The second half is the one that is easy to fake and easy to get wrong, so it is not asserted by
// reading the code. Every fixture is wrapped in a recording Proxy before it reaches the normalizer,
// the Proxy writes down each path that was actually touched, and the recorded set is compared with
// the descriptor in BOTH directions: a normalizer that quietly depends on an undocumented field
// fails, and so does a descriptor that documents a field nobody reads.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  QUICKBOOKS_FIXTURES,
  REALM,
  quickBooksEntity,
} from "./accounting-fixture.ts";
import {
  ACCOUNTING_ENTITY_TYPES,
  AccountingNormalizerError,
  COMPARISON_FIELDS,
  SETTLEMENT_FIELDS,
  centsFromDecimal,
  decimalFromCents,
  expectedSha256,
  extractSettlementFacts,
  moneyDecimal,
  normalizeProviderEntity,
  observedSha256,
  rateDecimal,
  rateUnitsFromDecimal,
  type AccountingEntityType,
} from "../src/accounting-normalizers.ts";

/**
 * Wrap a payload so every property read is recorded as a descriptor-shaped path.
 *
 * An array read contributes a `[]` segment and its elements share that prefix, which is exactly how
 * the descriptors are written, so the recorded set and the declared set are directly comparable.
 * Non-index reads on an array (`length`, `constructor`, iteration protocol) are passed straight
 * through: they are how `map` and `filter` work, not facts the normalizer depends on.
 */
function recordReads(value: unknown, sink: Set<string>, prefix = ""): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return new Proxy(value, {
      get(target, property, receiver) {
        const raw = Reflect.get(target, property, receiver);
        if (typeof property !== "string" || !/^\d+$/.test(property)) return raw;
        return recordReads(raw, sink, prefix);
      },
    });
  }
  return new Proxy(value as Record<string, unknown>, {
    get(target, property, receiver) {
      const raw = Reflect.get(target, property, receiver);
      if (typeof property === "symbol") return raw;
      const path = prefix ? `${prefix}.${property}` : property;
      if (Array.isArray(raw)) return recordReads(raw, sink, `${path}[]`);
      if (raw !== null && typeof raw === "object") return recordReads(raw, sink, path);
      sink.add(path);
      return raw;
    },
  });
}

function fixturesFor(entityType: AccountingEntityType) {
  return QUICKBOOKS_FIXTURES.filter((fixture) => fixture.entityType === entityType);
}

test("every entity type the contract names has both descriptors and at least one fixture", () => {
  for (const entityType of ACCOUNTING_ENTITY_TYPES) {
    assert.ok(COMPARISON_FIELDS[entityType], `${entityType} has no comparison descriptor`);
    assert.ok(SETTLEMENT_FIELDS[entityType], `${entityType} has no settlement descriptor`);
    assert.ok(fixturesFor(entityType).length > 0, `${entityType} has no fixture`);
  }
});

test("the hashing normalizer reads exactly its comparison descriptor, no more and no less", () => {
  for (const fixture of QUICKBOOKS_FIXTURES) {
    const entityType = fixture.entityType as AccountingEntityType;
    const reads = new Set<string>();
    const payload = recordReads(quickBooksEntity(fixture.file, entityType), reads);
    normalizeProviderEntity({ realmId: REALM, entityType, payload });
    assert.deepEqual(
      [...reads].sort(),
      [...COMPARISON_FIELDS[entityType]].sort(),
      `${fixture.file}: normalizer read set must equal COMPARISON_FIELDS.${entityType}`,
    );
  }
});

test("the settlement extractor reads exactly its settlement descriptor, no more and no less", () => {
  for (const fixture of QUICKBOOKS_FIXTURES) {
    const entityType = fixture.entityType as AccountingEntityType;
    const reads = new Set<string>();
    const payload = recordReads(quickBooksEntity(fixture.file, entityType), reads);
    extractSettlementFacts(entityType, payload);
    assert.deepEqual(
      [...reads].sort(),
      [...SETTLEMENT_FIELDS[entityType]].sort(),
      `${fixture.file}: settlement read set must equal SETTLEMENT_FIELDS.${entityType}`,
    );
  }
});

test("every fixture carries every field its comparison descriptor names", () => {
  for (const fixture of QUICKBOOKS_FIXTURES) {
    const entityType = fixture.entityType as AccountingEntityType;
    const normalized = normalizeProviderEntity({
      realmId: REALM,
      entityType,
      payload: quickBooksEntity(fixture.file, entityType),
    });
    for (const field of COMPARISON_FIELDS[entityType]) {
      const value = normalized.facts[field];
      assert.notEqual(value, undefined, `${fixture.file}: ${field} is absent from the fact set`);
      if (Array.isArray(value)) {
        assert.ok(value.length > 0, `${fixture.file}: ${field} is an empty array`);
        assertNoNull(value, `${fixture.file}: ${field}`);
      } else {
        assert.notEqual(value, null, `${fixture.file}: ${field} is null`);
      }
    }
  }
});

function assertNoNull(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (const element of value) assertNoNull(element, label);
    return;
  }
  assert.notEqual(value, null, `${label} carries a null element`);
}

test("provider metadata churn never changes the hash, and a compared field always does", async () => {
  const entity = quickBooksEntity("invoice-open.json", "Invoice") as Record<string, unknown>;
  const baseline = await observedSha256(
    normalizeProviderEntity({ realmId: REALM, entityType: "Invoice", payload: entity }),
  );

  // SyncToken and MetaData.LastUpdatedTime move on every provider-side touch. Section 5.2 exists
  // so that churn cannot manufacture a mismatch.
  const churned = {
    ...entity,
    SyncToken: "9",
    MetaData: { CreateTime: "2026-08-19T12:00:00-07:00", LastUpdatedTime: "2026-08-30T09:15:00-07:00" },
    DocNumber: "renamed-1001",
  };
  assert.equal(
    await observedSha256(
      normalizeProviderEntity({ realmId: REALM, entityType: "Invoice", payload: churned }),
    ),
    baseline,
  );

  const repriced = { ...entity, TotalAmt: 1261.00 };
  assert.notEqual(
    await observedSha256(
      normalizeProviderEntity({ realmId: REALM, entityType: "Invoice", payload: repriced }),
    ),
    baseline,
  );
});

test("the same fact set in a different realm is not the same entity", async () => {
  const payload = quickBooksEntity("invoice-open.json", "Invoice");
  const here = await observedSha256(
    normalizeProviderEntity({ realmId: REALM, entityType: "Invoice", payload }),
  );
  const elsewhere = await observedSha256(
    normalizeProviderEntity({ realmId: "9130350000000000000", entityType: "Invoice", payload }),
  );
  assert.notEqual(here, elsewhere);
});

test("an invoice's balance is deliberately outside the hash so a partial payment is not a mismatch", async () => {
  const open = quickBooksEntity("invoice-open.json", "Invoice");
  const paid = quickBooksEntity("invoice-paid.json", "Invoice");
  const partial = quickBooksEntity("invoice-partially-paid.json", "Invoice");

  const hash = async (payload: unknown) =>
    await observedSha256(normalizeProviderEntity({ realmId: REALM, entityType: "Invoice", payload }));

  // Same document, three settlement states, one hash. Section 5.4: settlement is judged by the
  // cumulative invariant, not by the document hash.
  assert.equal(await hash(open), await hash(paid));
  assert.equal(await hash(open), await hash(partial));

  assert.equal(extractSettlementFacts("Invoice", open).balanceCents, 126000);
  assert.equal(extractSettlementFacts("Invoice", partial).balanceCents, 76000);
  assert.equal(extractSettlementFacts("Invoice", paid).balanceCents, 0);
});

test("expected and observed hashes are produced by one function over one fact shape", async () => {
  const payload = quickBooksEntity("invoice-open.json", "Invoice");
  const normalized = normalizeProviderEntity({ realmId: REALM, entityType: "Invoice", payload });
  assert.equal(
    await expectedSha256({ realmId: REALM, entityType: "Invoice", facts: normalized.facts }),
    await observedSha256(normalized),
  );
});

test("an absent optional field is an explicit null, not a key that disappears", () => {
  const entity = quickBooksEntity("invoice-open.json", "Invoice") as Record<string, unknown>;
  const { DueDate: _dropped, ...withoutDueDate } = entity;
  const normalized = normalizeProviderEntity({
    realmId: REALM,
    entityType: "Invoice",
    payload: withoutDueDate,
  });
  assert.ok("DueDate" in normalized.facts);
  assert.equal(normalized.facts["DueDate"], null);
});

test("money is read as an exact decimal string and anything inexact is refused", () => {
  assert.equal(moneyDecimal(1260), "1260.00");
  assert.equal(moneyDecimal(1260.5), "1260.50");
  assert.equal(moneyDecimal("1260.05"), "1260.05");
  assert.equal(moneyDecimal("-315.00"), "-315.00");
  assert.equal(moneyDecimal(null), null);
  assert.equal(moneyDecimal(undefined), null);

  // A third decimal place cannot be represented in cents. Rounding it would be a silent cent of
  // error in an accounting comparison, so it is a refusal.
  assert.throws(() => moneyDecimal(1260.005), (error: unknown) =>
    error instanceof AccountingNormalizerError && error.code === "provider_amount_invalid");
  assert.throws(() => moneyDecimal("12.345"), (error: unknown) =>
    error instanceof AccountingNormalizerError && error.code === "provider_amount_invalid");
  assert.throws(() => moneyDecimal(Number.NaN), (error: unknown) =>
    error instanceof AccountingNormalizerError && error.code === "provider_amount_invalid");
  assert.throws(() => moneyDecimal({ value: 12 }), (error: unknown) =>
    error instanceof AccountingNormalizerError && error.code === "provider_amount_invalid");
});

test("cents round-trip exactly, including negative reversals", () => {
  for (const decimal of ["0.00", "1260.00", "0.05", "-315.00", "-0.01"]) {
    assert.equal(decimalFromCents(centsFromDecimal(decimal)!), decimal);
  }
  assert.equal(centsFromDecimal("1260.00"), 126000);
  assert.equal(centsFromDecimal("-315.00"), -31500);
});

test("a tax rate is read at four decimal places and compared as an exact integer", () => {
  assert.equal(rateDecimal(5), "5.0000");
  assert.equal(rateDecimal("5"), "5.0000");
  assert.equal(rateDecimal("5.0000"), "5.0000");
  assert.equal(rateDecimal(5.25), "5.2500");
  assert.equal(rateUnitsFromDecimal("5.0000"), 50000);
  assert.notEqual(rateUnitsFromDecimal("5.0000"), rateUnitsFromDecimal("6.0000"));
  assert.throws(() => rateDecimal("5.00001"), (error: unknown) =>
    error instanceof AccountingNormalizerError && error.code === "provider_rate_invalid");
});

test("a payment line that applies to two invoices is refused rather than split by guess", () => {
  const payment = quickBooksEntity("payment-partial-500.json", "Payment") as Record<string, unknown>;
  const ambiguous = {
    ...payment,
    Line: [{
      Amount: 500.00,
      LinkedTxn: [
        { TxnId: "2001", TxnType: "Invoice" },
        { TxnId: "2002", TxnType: "Invoice" },
      ],
    }],
  };
  assert.throws(() => extractSettlementFacts("Payment", ambiguous), (error: unknown) =>
    error instanceof AccountingNormalizerError && error.code === "provider_payment_line_ambiguous");
});

test("a payment's settlement links carry the line, the target, and exact cents", () => {
  const facts = extractSettlementFacts(
    "Payment",
    quickBooksEntity("payment-partial-500.json", "Payment"),
  );
  assert.deepEqual(facts.links, [{
    lineIndex: 0,
    linkedTxnType: "Invoice",
    linkedTxnId: "2001",
    amountCents: 50000,
  }]);
  assert.equal(facts.totalCents, 50000);
  assert.equal(facts.unappliedCents, 0);
});

test("an unsupported entity type and a payload with no id are both refused", () => {
  assert.throws(
    () => normalizeProviderEntity({
      realmId: REALM,
      entityType: "Estimate" as AccountingEntityType,
      payload: { Id: "1" },
    }),
    (error: unknown) =>
      error instanceof AccountingNormalizerError
      && error.code === "provider_entity_type_unsupported",
  );
  assert.throws(
    () => normalizeProviderEntity({ realmId: REALM, entityType: "Invoice", payload: {} }),
    (error: unknown) =>
      error instanceof AccountingNormalizerError && error.code === "provider_entity_id_missing",
  );
});

test("a compared leaf that is an object rather than a scalar is a shape error, not a silent hash", () => {
  const entity = quickBooksEntity("invoice-open.json", "Invoice") as Record<string, unknown>;
  assert.throws(
    () => normalizeProviderEntity({
      realmId: REALM,
      entityType: "Invoice",
      payload: { ...entity, TxnDate: { start: "2026-08-19" } },
    }),
    (error: unknown) =>
      error instanceof AccountingNormalizerError && error.code === "provider_entity_shape_invalid",
  );
});
