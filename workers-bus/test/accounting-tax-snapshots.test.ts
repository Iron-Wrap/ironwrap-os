// Slice S2. Versioned tax snapshots, staleness, and drift.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 5.4, "tax rate change mid-project". Every
// test here runs the real 0058-0061 SQL in `node:sqlite`, so the immutability and binding rules
// are executed rather than asserted about.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NOW,
  REALM,
  TENANT,
  quickBooksEntity,
  testEnv,
} from "./accounting-fixture.ts";
import type { AppEnv } from "../src/app-types.ts";
import {
  applyAccountingIntentCommand,
  deriveAccountingIntent,
  readAccountingIntent,
  recordAccountingIntentSubmission,
  type AccountingIntentKind,
  type AccountingIntentRecord,
} from "../src/accounting-intents.ts";
import {
  normalizeProviderEntity,
  providerFactEnvelope,
  type NormalizedEntityFacts,
} from "../src/accounting-normalizers.ts";
import {
  AccountingTaxSnapshotError,
  TAX_RATE_DRIFT_BLOCKER,
  TAX_SNAPSHOT_STALE_BLOCKER,
  assertAccountingIntentTaxBindingIntegrity,
  assessTaxSnapshotStaleness,
  bindAccountingIntentTaxSnapshots,
  currentTaxPolicySnapshot,
  detectTaxRateDrift,
  listAccountingIntentTaxBindings,
  preflightAccountingIntentTax,
  recordTaxPolicySnapshot,
  taxBindingSetSha256,
  type TaxPolicySnapshotRecord,
} from "../src/accounting-tax-snapshots.ts";
import { listAccountingExceptions } from "../src/accounting-exceptions.ts";

const LATER = new Date("2026-08-19T12:05:00.000Z");
const JURISDICTION = "CA-AB";

async function gst(
  env: AppEnv,
  ratePercent: string,
  effectiveFrom: string,
  sourceRef = `CRA GST bulletin ${effectiveFrom}`,
): Promise<TaxPolicySnapshotRecord> {
  return await recordTaxPolicySnapshot(env, {
    tenantId: TENANT,
    jurisdiction: JURISDICTION,
    taxCode: "GST",
    providerTaxCodeId: "3",
    ratePercent,
    effectiveFrom,
    sourceRef,
  }, NOW);
}

/** Derive one tax-bearing intent already bound to `snapshots`, the way S4 will. */
async function deriveBound(
  env: AppEnv,
  snapshots: readonly TaxPolicySnapshotRecord[],
  overrides: {
    intentId?: string;
    kind?: AccountingIntentKind;
    entityFile?: string;
    total?: string;
  } = {},
): Promise<AccountingIntentRecord> {
  const intentId = overrides.intentId ?? "acct-intent:job-0001:deposit_invoice";
  const facts = normalizeProviderEntity({
    realmId: REALM,
    entityType: "Invoice",
    payload: quickBooksEntity(overrides.entityFile ?? "invoice-open.json", "Invoice"),
  }).facts;

  const intent = await deriveAccountingIntent(env, {
    tenantId: TENANT,
    intentId,
    kind: overrides.kind ?? "deposit_invoice",
    roofJobId: "job-0001",
    basis: { roofJob: "job-0001", intentId, snapshots: snapshots.map((s) => s.snapshot_id) },
    sourceDocuments: [{ id: "quote-0001", version: 3 }],
    expected: providerFactEnvelope({ realmId: REALM, entityType: "Invoice", facts }),
    taxPolicySnapshotSha256: await taxBindingSetSha256(
      snapshots.map((snapshot) => snapshot.snapshot_sha256),
    ),
    realmId: REALM,
    providerPayload: { TotalAmt: overrides.total ?? "1260.00" },
    providerRequestId: `req-${intentId}`,
    subtotal: "1200.00",
    taxAmount: "60.00",
    totalAmount: overrides.total ?? "1260.00",
    authority: {
      permitRef: "permit:accounting:invoice",
      policyRef: "policy:accounting:invoice.create",
      policyVersion: "v1",
      maxAmount: "5000.00",
    },
    effectIdempotencyKey: `acct:${intentId}:v1`,
    derivedBy: { actorKind: "agent" },
  }, NOW);

  await bindAccountingIntentTaxSnapshots(env, {
    tenantId: TENANT,
    intentId,
    snapshots,
  }, NOW);
  return intent;
}

function providerRates(entries: ReadonlyArray<[string, string]>): Map<string, NormalizedEntityFacts> {
  const rates = new Map<string, NormalizedEntityFacts>();
  for (const [taxCode, file] of entries) {
    rates.set(taxCode, normalizeProviderEntity({
      realmId: REALM,
      entityType: "TaxRate",
      payload: quickBooksEntity(file, "TaxRate"),
    }));
  }
  return rates;
}

test("a tax snapshot is immutable: D1 refuses both an edit and a delete", async () => {
  const { env, db } = testEnv();
  const snapshot = await gst(env, "5.0000", "2008-01-01");

  assert.throws(
    () => db.raw.prepare(`UPDATE tax_policy_snapshots SET rate_percent = '6.0000' WHERE snapshot_id = ?`)
      .run(snapshot.snapshot_id),
    /tax_policy_snapshot_immutable/,
  );
  assert.throws(
    () => db.raw.prepare(`DELETE FROM tax_policy_snapshots WHERE snapshot_id = ?`)
      .run(snapshot.snapshot_id),
    /tax_policy_snapshot_immutable/,
  );

  const stored = db.raw.prepare(`SELECT rate_percent FROM tax_policy_snapshots WHERE snapshot_id = ?`)
    .get(snapshot.snapshot_id) as { rate_percent: string };
  assert.equal(stored.rate_percent, "5.0000");
});

test("the same rate recorded twice is one snapshot; a changed rate is a new version", async () => {
  const { env } = testEnv();
  const first = await gst(env, "5.0000", "2008-01-01");
  const again = await gst(env, "5.0000", "2008-01-01");
  assert.equal(again.snapshot_id, first.snapshot_id);
  assert.equal(again.version, 1);

  // A rate change never edits the row an already-submitted intent bound (section 5.4).
  const raised = await gst(env, "6.0000", "2026-09-01");
  assert.equal(raised.version, 2);
  assert.notEqual(raised.snapshot_sha256, first.snapshot_sha256);
  assert.equal(raised.rate_percent, "6.0000");
});

test("the current snapshot is the newest window containing the date, with nothing closed by an update", async () => {
  const { env } = testEnv();
  const old = await gst(env, "5.0000", "2008-01-01");
  const raised = await gst(env, "6.0000", "2026-09-01");

  const before = await currentTaxPolicySnapshot(env, {
    tenantId: TENANT, jurisdiction: JURISDICTION, taxCode: "GST", onDate: "2026-08-19",
  });
  const after = await currentTaxPolicySnapshot(env, {
    tenantId: TENANT, jurisdiction: JURISDICTION, taxCode: "GST", onDate: "2026-09-02",
  });
  assert.equal(before?.snapshot_id, old.snapshot_id);
  assert.equal(after?.snapshot_id, raised.snapshot_id);

  // A date before every window has no snapshot rather than the earliest one: an agent may not
  // invent a rate for a period no source covers (section 6).
  assert.equal(
    await currentTaxPolicySnapshot(env, {
      tenantId: TENANT, jurisdiction: JURISDICTION, taxCode: "GST", onDate: "2000-01-01",
    }),
    null,
  );
});

test("a binding must describe the snapshot it points at, and cannot be added after approval", async () => {
  const { env, db } = testEnv();
  const snapshot = await gst(env, "5.0000", "2008-01-01");
  const intent = await deriveBound(env, [snapshot]);

  // A binding whose recorded hash is not the snapshot's own hash is refused by the trigger, so a
  // later staleness check can never be comparing a pair the storage layer never agreed to.
  assert.throws(
    () => db.raw.prepare(
      `INSERT INTO accounting_intent_tax_bindings (
         binding_id, tenant_id, intent_id, snapshot_id, snapshot_sha256, jurisdiction, tax_code,
         bound_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "11111111-2222-3333-4444-555555555555", TENANT, intent.intent_id, snapshot.snapshot_id,
      "f".repeat(64), JURISDICTION, "PST", NOW.toISOString(),
    ),
    /accounting_tax_binding_snapshot_mismatch/,
  );

  const approved = await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    operation: "approve",
    actorUserId: "appu_accounting_0001",
    idempotencyKey: `approve:${intent.intent_id}`,
    request: { version: intent.version },
    requestedVersion: intent.version,
  }, NOW);
  assert.equal(approved.intent.state, "submission_pending");

  const pst = await recordTaxPolicySnapshot(env, {
    tenantId: TENANT, jurisdiction: JURISDICTION, taxCode: "PST", ratePercent: "7.0000",
    effectiveFrom: "2008-01-01", sourceRef: "synthetic provincial bulletin",
  }, NOW);
  await assert.rejects(
    bindAccountingIntentTaxSnapshots(env, {
      tenantId: TENANT, intentId: intent.intent_id, snapshots: [pst],
    }, LATER),
    /accounting_tax_binding_intent_not_bindable/,
  );
});

test("bindings are append-only", async () => {
  const { env, db } = testEnv();
  const snapshot = await gst(env, "5.0000", "2008-01-01");
  const intent = await deriveBound(env, [snapshot]);
  const [binding] = await listAccountingIntentTaxBindings(env, TENANT, intent.intent_id);

  assert.throws(
    () => db.raw.prepare(`UPDATE accounting_intent_tax_bindings SET tax_code = 'PST' WHERE binding_id = ?`)
      .run(binding!.binding_id),
    /accounting_tax_binding_append_only/,
  );
  assert.throws(
    () => db.raw.prepare(`DELETE FROM accounting_intent_tax_bindings WHERE binding_id = ?`)
      .run(binding!.binding_id),
    /accounting_tax_binding_append_only/,
  );
});

test("the intent's single bound hash is the order-independent hash over the bound set", async () => {
  const { env, db } = testEnv();
  const gstSnapshot = await gst(env, "5.0000", "2008-01-01");
  const pst = await recordTaxPolicySnapshot(env, {
    tenantId: TENANT, jurisdiction: JURISDICTION, taxCode: "PST", ratePercent: "7.0000",
    effectiveFrom: "2008-01-01", sourceRef: "synthetic provincial bulletin",
  }, NOW);

  assert.equal(
    await taxBindingSetSha256([gstSnapshot.snapshot_sha256, pst.snapshot_sha256]),
    await taxBindingSetSha256([pst.snapshot_sha256, gstSnapshot.snapshot_sha256]),
  );

  const intent = await deriveBound(env, [gstSnapshot, pst]);
  await assertAccountingIntentTaxBindingIntegrity(env, TENANT, intent.intent_id);
  assert.equal(
    (await listAccountingIntentTaxBindings(env, TENANT, intent.intent_id)).length,
    2,
  );

  // Bind a third code behind the module's back: the intent's hash no longer describes the set,
  // and the integrity check is what notices. D1 cannot: it has no SHA-256.
  const fuel = await recordTaxPolicySnapshot(env, {
    tenantId: TENANT, jurisdiction: JURISDICTION, taxCode: "FUEL", ratePercent: "1.5000",
    effectiveFrom: "2008-01-01", sourceRef: "synthetic fuel levy",
  }, NOW);
  db.raw.prepare(
    `INSERT INTO accounting_intent_tax_bindings (
       binding_id, tenant_id, intent_id, snapshot_id, snapshot_sha256, jurisdiction, tax_code,
       bound_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "99999999-8888-7777-6666-555555555555", TENANT, intent.intent_id, fuel.snapshot_id,
    fuel.snapshot_sha256, JURISDICTION, "FUEL", NOW.toISOString(),
  );
  await assert.rejects(
    assertAccountingIntentTaxBindingIntegrity(env, TENANT, intent.intent_id),
    (error: unknown) =>
      error instanceof AccountingTaxSnapshotError
      && error.code === "accounting_intent_tax_binding_mismatch",
  );
});

test("an un-submitted intent whose snapshot was superseded is stale; a submitted one never is", async () => {
  const { env } = testEnv();
  const old = await gst(env, "5.0000", "2008-01-01");
  const candidate = await deriveBound(env, [old], {
    intentId: "acct-intent:job-0001:progress_invoice",
    kind: "progress_invoice",
  });
  const submittedIntent = await deriveBound(env, [old], {
    intentId: "acct-intent:job-0002:deposit_invoice",
  });

  // Approve and settle the second one, so it is what was actually posted at 5%.
  await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: submittedIntent.intent_id,
    operation: "approve",
    actorUserId: "appu_accounting_0001",
    idempotencyKey: `approve:${submittedIntent.intent_id}`,
    request: { version: submittedIntent.version },
    requestedVersion: submittedIntent.version,
  }, NOW);
  const settled = await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: submittedIntent.intent_id,
    outcome: {
      effectId: "effect:ironwrap:1",
      state: "succeeded",
      attemptId: "effect:ironwrap:1:attempt:1",
      attemptState: "succeeded",
      providerExternalId: "2001",
      requestHash: "b".repeat(64),
      providerResponseHash: "c".repeat(64),
      readbackHash: "d".repeat(64),
      resultCode: null,
    },
  }, LATER);
  assert.equal(settled.state, "submitted");

  await gst(env, "6.0000", "2026-09-01");

  const candidateReport = await assessTaxSnapshotStaleness(env, {
    tenantId: TENANT, intentId: candidate.intent_id, onDate: "2026-09-02",
  });
  assert.equal(candidateReport.stale, true);
  assert.equal(candidateReport.blockerCode, TAX_SNAPSHOT_STALE_BLOCKER);

  const submittedReport = await assessTaxSnapshotStaleness(env, {
    tenantId: TENANT, intentId: submittedIntent.intent_id, onDate: "2026-09-02",
  });
  assert.equal(submittedReport.stale, false, "a submitted intent keeps the rate that was posted");
  assert.equal(submittedReport.blockerCode, null);

  // Before the new rate takes effect, nothing is stale.
  const stillCurrent = await assessTaxSnapshotStaleness(env, {
    tenantId: TENANT, intentId: candidate.intent_id, onDate: "2026-08-19",
  });
  assert.equal(stillCurrent.stale, false);
});

test("a provider rate that differs from the bound snapshot is drift, and the snapshot is untouched", async () => {
  const { env, db } = testEnv();
  const snapshot = await gst(env, "5.0000", "2008-01-01");
  const intent = await deriveBound(env, [snapshot]);

  const clean = await detectTaxRateDrift(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    providerRates: providerRates([["GST", "tax-rate-gst-5.json"]]),
  }, NOW);
  assert.equal(clean.drifted, false);
  assert.equal(clean.exception, null);

  const drifted = await detectTaxRateDrift(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    providerRates: providerRates([["GST", "tax-rate-gst-6.json"]]),
  }, NOW);
  assert.equal(drifted.drifted, true);
  assert.equal(drifted.exception?.reason_code, "tax_rate_drift");
  assert.deepEqual(drifted.entries.map((entry) => entry.providerRatePercent), ["6.0000"]);

  const stored = db.raw.prepare(`SELECT rate_percent FROM tax_policy_snapshots WHERE snapshot_id = ?`)
    .get(snapshot.snapshot_id) as { rate_percent: string };
  assert.equal(stored.rate_percent, "5.0000", "the local snapshot is never rewritten to match");

  // A sweep that repeats the read must not flood the accountant's queue.
  await detectTaxRateDrift(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    providerRates: providerRates([["GST", "tax-rate-gst-6.json"]]),
  }, LATER);
  const open = await listAccountingExceptions(env, TENANT, { status: "open" });
  assert.equal(open.length, 1);
});

test("a rate we could not read is not a rate that differs", async () => {
  const { env } = testEnv();
  const snapshot = await gst(env, "5.0000", "2008-01-01");
  const intent = await deriveBound(env, [snapshot]);

  // `readProviderTaxRates` omits a code whose read was unavailable, so an outage must not block
  // every submission for its duration.
  const report = await detectTaxRateDrift(env, {
    tenantId: TENANT, intentId: intent.intent_id, providerRates: new Map(),
  }, NOW);
  assert.equal(report.drifted, false);
  assert.equal(report.entries[0]?.providerRatePercent, null);
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 0);
});

test("the submission preflight blocks a stale candidate and a drifted rate, and passes a clean one", async () => {
  const { env } = testEnv();
  const snapshot = await gst(env, "5.0000", "2008-01-01");
  const clean = await deriveBound(env, [snapshot]);

  const passing = await preflightAccountingIntentTax(env, {
    tenantId: TENANT,
    intentId: clean.intent_id,
    onDate: "2026-08-19",
    providerRates: providerRates([["GST", "tax-rate-gst-5.json"]]),
  }, NOW);
  assert.equal(passing.ok, true);
  assert.equal(passing.blockerCode, null);
  assert.equal((await readAccountingIntent(env, TENANT, clean.intent_id))?.state, "pending_review");

  await gst(env, "6.0000", "2026-09-01");
  const stale = await preflightAccountingIntentTax(env, {
    tenantId: TENANT,
    intentId: clean.intent_id,
    onDate: "2026-09-02",
    providerRates: providerRates([["GST", "tax-rate-gst-5.json"]]),
  }, LATER);
  assert.equal(stale.ok, false);
  assert.equal(stale.blockerCode, TAX_SNAPSHOT_STALE_BLOCKER);
  const blocked = await readAccountingIntent(env, TENANT, clean.intent_id);
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.blocker_code, TAX_SNAPSHOT_STALE_BLOCKER);

  const drifting = await preflightAccountingIntentTax(env, {
    tenantId: TENANT,
    intentId: clean.intent_id,
    onDate: "2026-09-02",
    providerRates: providerRates([["GST", "tax-rate-gst-6.json"]]),
  }, LATER);
  assert.equal(drifting.blockerCode, TAX_RATE_DRIFT_BLOCKER);
  assert.equal(
    (await readAccountingIntent(env, TENANT, clean.intent_id))?.blocker_code,
    TAX_RATE_DRIFT_BLOCKER,
  );
});

test("mid-project rate change: what was posted keeps its rate, what is still a candidate is re-derived", async () => {
  const { env } = testEnv();

  // 1. The deposit invoice is derived, approved and posted while GST is 5%.
  const gstFive = await gst(env, "5.0000", "2008-01-01");
  const deposit = await deriveBound(env, [gstFive]);
  await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: deposit.intent_id,
    operation: "approve",
    actorUserId: "appu_accounting_0001",
    idempotencyKey: `approve:${deposit.intent_id}`,
    request: { version: deposit.version },
    requestedVersion: deposit.version,
  }, NOW);
  const posted = await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: deposit.intent_id,
    outcome: {
      effectId: "effect:ironwrap:1",
      state: "succeeded",
      attemptId: "effect:ironwrap:1:attempt:1",
      attemptState: "succeeded",
      providerExternalId: "2001",
      requestHash: "b".repeat(64),
      providerResponseHash: "c".repeat(64),
      readbackHash: "d".repeat(64),
      resultCode: null,
    },
  }, LATER);
  assert.equal(posted.state, "submitted");
  assert.equal(posted.tax_policy_snapshot_sha256, await taxBindingSetSha256([gstFive.snapshot_sha256]));

  // 2. Mid-project, the rate changes. A new snapshot; nothing edited.
  const gstSix = await gst(env, "6.0000", "2026-09-01");
  assert.equal(gstSix.version, 2);

  // 3. The posted deposit keeps its 5% snapshot and is not stale, at any later date.
  const postedReport = await assessTaxSnapshotStaleness(env, {
    tenantId: TENANT, intentId: deposit.intent_id, onDate: "2026-09-30",
  });
  assert.equal(postedReport.stale, false);
  assert.equal(
    (await readAccountingIntent(env, TENANT, deposit.intent_id))?.tax_policy_snapshot_sha256,
    await taxBindingSetSha256([gstFive.snapshot_sha256]),
  );

  // 4. A progress invoice still bound to 5% is blocked `candidate_changed` before it can submit.
  const staleCandidate = await deriveBound(env, [gstFive], {
    intentId: "acct-intent:job-0001:progress_invoice",
    kind: "progress_invoice",
  });
  const staleFlight = await preflightAccountingIntentTax(env, {
    tenantId: TENANT,
    intentId: staleCandidate.intent_id,
    onDate: "2026-09-30",
    providerRates: providerRates([["GST", "tax-rate-gst-6.json"]]),
  }, LATER);
  assert.equal(staleFlight.ok, false);
  assert.equal(staleFlight.staleness.stale, true);
  // Drift is what the accountant sees first: the provider already charges 6% while this candidate
  // still claims 5%.
  assert.equal(staleFlight.blockerCode, TAX_RATE_DRIFT_BLOCKER);

  // 5. Re-derived against the current snapshot, the candidate is clean and the provider agrees.
  const reDerived = await deriveBound(env, [gstSix], {
    intentId: "acct-intent:job-0001:progress_invoice_v2",
    kind: "progress_invoice",
  });
  const cleanFlight = await preflightAccountingIntentTax(env, {
    tenantId: TENANT,
    intentId: reDerived.intent_id,
    onDate: "2026-09-30",
    providerRates: providerRates([["GST", "tax-rate-gst-6.json"]]),
  }, LATER);
  assert.equal(cleanFlight.ok, true);
  assert.equal(cleanFlight.blockerCode, null);

  // 6. Both snapshots still exist, unedited: the record of what each intent bound survives.
  const five = await currentTaxPolicySnapshot(env, {
    tenantId: TENANT, jurisdiction: JURISDICTION, taxCode: "GST", onDate: "2026-08-19",
  });
  const six = await currentTaxPolicySnapshot(env, {
    tenantId: TENANT, jurisdiction: JURISDICTION, taxCode: "GST", onDate: "2026-09-30",
  });
  assert.equal(five?.rate_percent, "5.0000");
  assert.equal(six?.rate_percent, "6.0000");
});
