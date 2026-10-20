import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAccountingIntentCommand,
  deriveAccountingIntent,
  recordAccountingIntentSubmission,
} from "../src/accounting-intents.ts";
import { localFactEnvelope, normalizeProviderEntity } from "../src/accounting-normalizers.ts";
import {
  recordAccountingObservation,
  reconcileAccountingIntent,
} from "../src/accounting-reconciliation.ts";
import {
  bindAccountingIntentTaxSnapshots,
  recordTaxPolicySnapshot,
  taxBindingSetSha256,
} from "../src/accounting-tax-snapshots.ts";
import {
  deriveNativeFinalInvoiceForJob,
  deriveNativeFinalInvoiceIntents,
  readNativeInitialProviderMapping,
  recordNativeFinalInvoiceProviderBinding,
} from "../src/native-final-invoice-producer.ts";
import { canonicalJson, sha256Hex } from "../src/newo-hash.ts";
import {
  approveNativeFinalInvoice,
  isNativeFinalInvoiceCurrent,
  listNativeFinalInvoiceCandidates,
  nativeFinalInvoiceProviderPayload,
} from "../src/quickbooks-native-final-invoice.ts";
import { AccountingTestD1, NOW, readAccountingMigration, REALM, TENANT } from "./accounting-fixture.ts";
import type { AppEnv } from "../src/app-types.ts";

const JOB = "job-native-final-0001";
const CUSTOMER = "customer-native-0001";
const ASSIGNMENT = "assignment-native-0001";
const PACKAGE = "package-native-final-0001";
const COMPLETE_AT = "2026-08-20T10:00:00.000Z";
const DERIVE_AT = new Date("2026-08-21T12:00:00.000Z");
/** The contract `seedNativeSource` accepts, and the OD-01 contract a case may replace it with. */
const FIRST_CONTRACT = {
  quote: "quote-rev-0001",
  proposal: "proposal-rev-0001",
  publication: "publication-event-0001",
  acceptance: "acceptance-binding-0001",
};
const OD01_CONTRACT = {
  quote: "quote-rev-0002",
  proposal: "proposal-rev-0002",
  publication: "publication-event-0002",
  acceptance: "acceptance-binding-0002",
};
/** OD-01: no deposit, the whole contract paid on completion. */
const OD01_TERMS = { deposit_percent: 0, payment_schedule: ["completion"], payment_terms_days: 30 };
const DEPOSIT_TERMS = { deposit_percent: 25, payment_schedule: ["deposit", "completion"], payment_terms_days: 30 };

function nativeTestEnv(): { env: AppEnv; db: AccountingTestD1 } {
  const db = new AccountingTestD1();
  db.raw.exec(`
    CREATE TABLE operating_roof_jobs (
      roof_job_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      job_status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (roof_job_id, tenant_id)
    );
    CREATE TABLE operating_job_assignments (
      assignment_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      roof_job_id TEXT NOT NULL,
      assignment_version INTEGER NOT NULL,
      supersedes_assignment_id TEXT
    );
    CREATE TABLE work_packages (
      work_package_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      work_object_type TEXT NOT NULL,
      work_object_id TEXT NOT NULL,
      physical_context_type TEXT NOT NULL,
      physical_context_id TEXT NOT NULL,
      status TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (work_package_id, tenant_id, version)
    );
    CREATE TABLE work_package_events (
      event_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      work_package_id TEXT NOT NULL,
      work_package_version INTEGER NOT NULL,
      event_kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE field_actions (
      device_action_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      work_package_id TEXT,
      work_package_version INTEGER,
      status TEXT NOT NULL,
      manifest_key TEXT,
      evidence_slot_id TEXT,
      evidence_freshness TEXT,
      evidence_conflict_state TEXT,
      evidence_verification TEXT,
      evidence_disposition TEXT,
      evidence_correction_of TEXT,
      evidence_item_correction_of TEXT,
      created_at TEXT NOT NULL,
      capture_completed_at TEXT
    );
    CREATE TABLE field_action_media (
      device_action_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      r2_stored_at TEXT NOT NULL,
      PRIMARY KEY (device_action_id, attachment_id)
    );
    CREATE TABLE commercial_quote_revisions (
      quote_revision_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      customer_quote_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      roof_job_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      supersedes_quote_revision_id TEXT,
      status TEXT NOT NULL,
      currency TEXT NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      tax_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      terms_hash TEXT NOT NULL,
      terms_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE commercial_quote_lines (
      quote_revision_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      tax_code TEXT,
      tax_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      PRIMARY KEY (quote_revision_id, line_id)
    );
    CREATE TABLE commercial_proposal_revisions (
      proposal_revision_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      proposal_pack_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      quote_revision_id TEXT NOT NULL,
      roof_job_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      supersedes_proposal_revision_id TEXT,
      terms_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE commercial_proposal_publication_events (
      publication_event_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      proposal_revision_id TEXT NOT NULL,
      proposal_pack_id TEXT NOT NULL,
      publication_version INTEGER NOT NULL,
      state TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE commercial_acceptance_bindings (
      acceptance_binding_id TEXT PRIMARY KEY,
      acceptance_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      quote_revision_id TEXT NOT NULL,
      proposal_revision_id TEXT NOT NULL,
      roof_job_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      terms_hash TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      bound_at TEXT NOT NULL
    );
  `);
  db.raw.exec(readAccountingMigration("0100_native_final_invoice_derivation.sql"));
  db.raw.exec(readAccountingMigration("0102_native_final_invoice_provider_binding_authority.sql"));
  return { env: { DB: db } as unknown as AppEnv, db };
}

function seedNativeSource(db: AccountingTestD1): void {
  db.raw
    .prepare(
      `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, customer_id, version, job_status, updated_at)
     VALUES (?, ?, ?, 1, 'in_progress', ?)`,
    )
    .run(JOB, TENANT, CUSTOMER, COMPLETE_AT);
  db.raw
    .prepare(
      `INSERT INTO operating_job_assignments
       (assignment_id, tenant_id, roof_job_id, assignment_version, supersedes_assignment_id)
     VALUES (?, ?, ?, 1, NULL)`,
    )
    .run(ASSIGNMENT, TENANT, JOB);
  const definition = JSON.stringify({
    steps: [{ sequence: 1, required_evidence: "installed roof evidence" }],
    hold_points: [],
  });
  db.raw
    .prepare(
      `INSERT INTO work_packages (
       work_package_id, tenant_id, version, job_id, assignment_id, work_object_type,
       work_object_id, physical_context_type, physical_context_id, status, definition_json,
       completed_at, updated_at
     ) VALUES (?, ?, 1, ?, ?, 'Roof Job', ?, 'Roof Site', ?, 'Completed', ?, ?, ?)`,
    )
    .run(PACKAGE, TENANT, JOB, ASSIGNMENT, JOB, JOB, definition, COMPLETE_AT, COMPLETE_AT);
  const events = db.raw.prepare(
    `INSERT INTO work_package_events (
       event_id, tenant_id, work_package_id, work_package_version, event_kind,
       occurred_at, payload_json, created_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
  );
  events.run(
    "event-issued-native-0001",
    TENANT,
    PACKAGE,
    "issued",
    "2026-08-20T08:00:00.000Z",
    "{}",
    "2026-08-20T08:00:00.000Z",
  );
  events.run(
    "event-review-native-0001",
    TENANT,
    PACKAGE,
    "evidence_reviewed",
    "2026-08-20T09:30:00.000Z",
    JSON.stringify({
      target_event_id: "wpe_native_step_0001",
      disposition: "Accepted",
    }),
    "2026-08-20T09:30:00.000Z",
  );
  events.run("event-complete-native-0001", TENANT, PACKAGE, "complete_work", COMPLETE_AT, "{}", COMPLETE_AT);
  db.raw
    .prepare(
      `INSERT INTO field_actions (
       device_action_id, tenant_id, job_id, assignment_id, work_package_id,
       work_package_version, status, manifest_key, evidence_slot_id, evidence_freshness,
       evidence_conflict_state, evidence_verification, evidence_disposition,
       evidence_correction_of, evidence_item_correction_of, created_at, capture_completed_at
     ) VALUES (?, ?, ?, ?, ?, 1, 'verified', ?, 'step:1', 'Current', 'None',
       'Verified', 'Open', NULL, NULL, ?, ?)`,
    )
    .run(
      "capture-native-step-0001",
      TENANT,
      JOB,
      ASSIGNMENT,
      PACKAGE,
      "evidence/native-step-0001/manifest.json",
      "2026-08-20T09:00:00.000Z",
      "2026-08-20T09:00:00.000Z",
    );
  db.raw
    .prepare(
      `INSERT INTO field_action_media (
       device_action_id, attachment_id, evidence_id, checksum_sha256, r2_key, r2_stored_at
     ) VALUES (?, 'attachment-native-step-0001', 'native_step_0001', ?, ?, ?)`,
    )
    .run("capture-native-step-0001", "a".repeat(64), "evidence/native-step-0001/raw.jpg", "2026-08-20T09:00:00.000Z");

  const termsHash = "b".repeat(64);
  db.raw
    .prepare(
      `INSERT INTO commercial_quote_revisions (
       quote_revision_id, tenant_id, customer_quote_id, revision_number, roof_job_id,
       customer_id, status, currency, subtotal_cents, tax_cents, total_cents, terms_hash,
       created_at
     ) VALUES ('quote-rev-0001', ?, 'quote-pack-0001', 1, ?, ?, 'approved', 'CAD',
       200000, 10000, 210000, ?, '2026-08-19T08:00:00.000Z')`,
    )
    .run(TENANT, JOB, CUSTOMER, termsHash);
  db.raw
    .prepare(
      `INSERT INTO commercial_quote_lines (
       quote_revision_id, line_id, sequence, subtotal_cents, tax_code, tax_cents, total_cents
     ) VALUES ('quote-rev-0001', 'line-roof-0001', 1, 200000, 'GST', 10000, 210000)`,
    )
    .run();
  db.raw
    .prepare(
      `INSERT INTO commercial_proposal_revisions (
       proposal_revision_id, tenant_id, proposal_pack_id, revision_number, quote_revision_id,
       roof_job_id, customer_id, terms_hash, created_at
     ) VALUES ('proposal-rev-0001', ?, 'proposal-pack-0001', 1, 'quote-rev-0001', ?, ?, ?,
       '2026-08-19T09:00:00.000Z')`,
    )
    .run(TENANT, JOB, CUSTOMER, termsHash);
  db.raw
    .prepare(
      `INSERT INTO commercial_proposal_publication_events (
       publication_event_id, tenant_id, proposal_revision_id, proposal_pack_id,
       publication_version, state, occurred_at
     ) VALUES ('publication-event-0001', ?, 'proposal-rev-0001', 'proposal-pack-0001',
       1, 'published', '2026-08-19T10:00:00.000Z')`,
    )
    .run(TENANT);
  db.raw
    .prepare(
      `INSERT INTO commercial_acceptance_bindings (
       acceptance_binding_id, acceptance_id, tenant_id, quote_revision_id,
       proposal_revision_id, roof_job_id, customer_id, terms_hash, receipt_hash,
       accepted_at, bound_at
     ) VALUES ('acceptance-binding-0001', 'acceptance-native-0001', ?, 'quote-rev-0001',
       'proposal-rev-0001', ?, ?, ?, ?, '2026-08-19T11:00:00.000Z',
       '2026-08-19T11:01:00.000Z')`,
    )
    .run(TENANT, JOB, CUSTOMER, termsHash, "c".repeat(64));
}

async function currentCommercialAnchor(
  db: AccountingTestD1,
  head = FIRST_CONTRACT,
): Promise<{ commercialTermsHash: string; commercialHeadSha256: string }> {
  const quote = db.raw
    .prepare("SELECT * FROM commercial_quote_revisions WHERE tenant_id = ? AND quote_revision_id = ?")
    .get(TENANT, head.quote) as Record<string, unknown>;
  const lines = db.raw
    .prepare("SELECT * FROM commercial_quote_lines WHERE quote_revision_id = ? ORDER BY sequence, line_id")
    .all(head.quote) as Record<string, unknown>[];
  const proposal = db.raw
    .prepare("SELECT * FROM commercial_proposal_revisions WHERE tenant_id = ? AND proposal_revision_id = ?")
    .get(TENANT, head.proposal) as Record<string, unknown>;
  const publication = db.raw
    .prepare("SELECT * FROM commercial_proposal_publication_events WHERE tenant_id = ? AND publication_event_id = ?")
    .get(TENANT, head.publication) as Record<string, unknown>;
  const acceptance = db.raw
    .prepare("SELECT * FROM commercial_acceptance_bindings WHERE tenant_id = ? AND acceptance_binding_id = ?")
    .get(TENANT, head.acceptance) as Record<string, unknown>;
  const quoteSha256 = await sha256Hex(canonicalJson({ quote, lines }));
  const proposalSha256 = await sha256Hex(canonicalJson(proposal));
  const publicationSha256 = await sha256Hex(canonicalJson(publication));
  const acceptanceSha256 = await sha256Hex(canonicalJson(acceptance));
  return {
    commercialTermsHash: String(quote.terms_hash),
    commercialHeadSha256: await sha256Hex(canonicalJson({
      quote_sha256: quoteSha256,
      proposal_sha256: proposalSha256,
      publication_sha256: publicationSha256,
      acceptance_sha256: acceptanceSha256,
    })),
  };
}

function invoiceRead(total = 525, subtotal = 500, tax = 25, currency = "CAD") {
  return {
    Id: "2001",
    CustomerRef: { value: "7" },
    CurrencyRef: { value: currency },
    SalesTermRef: { value: "9" },
    TxnDate: "2026-08-01",
    DueDate: "2026-08-31",
    TotalAmt: total,
    Balance: total,
    TxnTaxDetail: { TotalTax: tax },
    Line: [
      {
        Amount: subtotal,
        Description: "Residential roofing deposit",
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
          ItemRef: { value: "8" },
          TaxCodeRef: { value: "10" },
        },
      },
      {
        Amount: subtotal,
        DetailType: "SubTotalLineDetail",
        SubTotalLineDetail: {},
      },
    ],
  };
}

async function seedPriorInvoice(
  env: AppEnv,
  amounts = { subtotal: "500.00", tax: "25.00", total: "525.00" },
  settle = true,
  providerCurrency = "CAD",
): Promise<void> {
  const snapshot = await recordTaxPolicySnapshot(
    env,
    {
      tenantId: TENANT,
      jurisdiction: "CA-AB",
      taxCode: "GST",
      providerTaxCodeId: "10",
      ratePercent: "5.0000",
      effectiveFrom: "2026-01-01",
      sourceRef: "CRA GST policy snapshot 2026-01-01",
    },
    NOW,
  );
  const payload = invoiceRead(Number(amounts.total), Number(amounts.subtotal), Number(amounts.tax), providerCurrency);
  const intent = await deriveAccountingIntent(
    env,
    {
      tenantId: TENANT,
      intentId: "acct-prior-deposit-0001",
      kind: "deposit_invoice",
      roofJobId: JOB,
      basis: { schema_version: 1, source: "accepted_deposit_schedule" },
      sourceDocuments: [{ id: "quote-rev-0001", version: 1 }],
      expected: localFactEnvelope({
        realmId: REALM,
        entityType: "Invoice",
        payload,
      }),
      taxPolicySnapshotSha256: await taxBindingSetSha256([snapshot.snapshot_sha256]),
      realmId: REALM,
      providerPayload: {
        CustomerRef: { value: "7" },
        CurrencyRef: { value: providerCurrency },
        SalesTermRef: { value: "9" },
        TxnDate: "2026-08-01",
        DueDate: "2026-08-31",
        Line: [payload.Line[0]],
      },
      providerRequestId: "request-prior-deposit-0001",
      subtotal: amounts.subtotal,
      taxAmount: amounts.tax,
      totalAmount: amounts.total,
      authority: {
        permitRef: "permit:prior-deposit",
        policyRef: "policy:prior-deposit",
        policyVersion: "v1",
        maxAmount: "25000.00",
      },
      effectIdempotencyKey: "quickbooks:prior-deposit:0001",
      derivedBy: { actorKind: "agent" },
    },
    NOW,
  );
  await bindAccountingIntentTaxSnapshots(
    env,
    {
      tenantId: TENANT,
      intentId: intent.intent_id,
      snapshots: [snapshot],
    },
    NOW,
  );
  if (!settle) return;
  const approved = await applyAccountingIntentCommand(
    env,
    {
      tenantId: TENANT,
      intentId: intent.intent_id,
      operation: "approve",
      actorUserId: "appu_accounting_0001",
      idempotencyKey: "approve-prior-deposit-0001",
      request: { intent_id: intent.intent_id },
      requestedVersion: intent.version,
    },
    NOW,
  );
  assert.equal(approved.intent.state, "submission_pending");
  await recordAccountingIntentSubmission(
    env,
    {
      tenantId: TENANT,
      intentId: intent.intent_id,
      outcome: {
        effectId: "effect-prior-deposit-0001",
        state: "succeeded",
        attemptId: "attempt-prior-deposit-0001",
        attemptState: "succeeded",
        providerExternalId: "2001",
        requestHash: "d".repeat(64),
        providerResponseHash: "e".repeat(64),
        readbackHash: "f".repeat(64),
        resultCode: null,
      },
    },
    new Date("2026-08-20T11:00:00.000Z"),
  );
  const normalized = normalizeProviderEntity({
    realmId: REALM,
    entityType: "Invoice",
    payload,
  });
  const reconciled = await reconcileAccountingIntent(
    env,
    {
      tenantId: TENANT,
      intentId: intent.intent_id,
      read: {
        status: "ok",
        realmId: REALM,
        entityType: "Invoice",
        entityId: normalized.entityId,
        payload,
        normalized,
        readAt: "2026-08-20T11:01:00.000Z",
        source: "dispatch_readback",
        effectAttemptId: "attempt-prior-deposit-0001",
      },
    },
    new Date("2026-08-20T11:01:00.000Z"),
  );
  assert.equal(reconciled.verdict, "partially_settled");
}

test("native completion derives one exact remaining-balance intent and replays idempotently", async () => {
  const { env, db } = nativeTestEnv();
  seedNativeSource(db);
  await seedPriorInvoice(env);

  const first = await deriveNativeFinalInvoiceForJob(
    env,
    {
      tenantId: TENANT,
      roofJobId: JOB,
    },
    DERIVE_AT,
  );
  assert.equal(first.outcome, "intent_derived");
  if (first.outcome !== "intent_derived") return;
  assert.equal(first.replayed, false);

  const intent = db.raw
    .prepare("SELECT * FROM accounting_intents WHERE intent_id = ?")
    .get(first.accounting_intent_id) as Record<string, unknown>;
  assert.equal(intent.subtotal, "1500.00");
  assert.equal(intent.tax_amount, "75.00");
  assert.equal(intent.total_amount, "1575.00");
  assert.equal(intent.final_invoice_intent_id, intent.intent_id);
  const basis = JSON.parse(String(intent.basis_json)) as Record<string, any>;
  assert.equal(basis.schema_version, 2);
  assert.equal(basis.commercial.already_invoiced, "525.00");
  assert.equal(basis.prior_invoices.length, 1);
  assert.equal(basis.prior_invoices[0].provider_entity_id, "2001");

  const listing = await listNativeFinalInvoiceCandidates(env, {
    tenantId: TENANT,
    realmId: REALM,
    roofJobId: JOB,
    limit: 10,
  });
  assert.equal(listing.blockers.length, 0);
  assert.equal(listing.candidates.length, 1);
  assert.equal(listing.candidates[0]!.commercial.already_invoiced, "525.00");
  assert.equal(listing.candidates[0]!.commercial.final_balance, "1575.00");

  const replay = await deriveNativeFinalInvoiceForJob(
    env,
    {
      tenantId: TENANT,
      roofJobId: JOB,
    },
    new Date("2026-08-21T12:05:00.000Z"),
  );
  assert.equal(replay.outcome, "intent_derived");
  if (replay.outcome === "intent_derived") {
    assert.equal(replay.accounting_intent_id, first.accounting_intent_id);
    assert.equal(replay.replayed, true);
  }
  assert.equal(
    Number(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS count FROM accounting_intents WHERE final_invoice_intent_id IS NOT NULL")
          .get() as any
      ).count,
    ),
    1,
  );
  assert.equal(
    Number((db.raw.prepare("SELECT COUNT(*) AS count FROM native_completion_packets").get() as any).count),
    1,
  );
  assert.equal(
    Number(
      (db.raw.prepare("SELECT COUNT(*) AS count FROM native_final_invoice_derivation_observations").get() as any).count,
    ),
    1,
  );
});

test("incomplete or post-completion evidence produces durable blockers and no invoice", async () => {
  const incomplete = nativeTestEnv();
  seedNativeSource(incomplete.db);
  incomplete.db.raw.prepare("UPDATE work_packages SET status = 'In Progress', completed_at = NULL").run();
  const first = await deriveNativeFinalInvoiceForJob(
    incomplete.env,
    {
      tenantId: TENANT,
      roofJobId: JOB,
    },
    DERIVE_AT,
  );
  assert.equal(first.outcome, "blocked");
  if (first.outcome === "blocked") assert.equal(first.blocker_code, "work_package_set_incomplete");
  assert.equal(
    Number((incomplete.db.raw.prepare("SELECT COUNT(*) AS count FROM accounting_intents").get() as any).count),
    0,
  );

  const drifted = nativeTestEnv();
  seedNativeSource(drifted.db);
  drifted.db.raw.prepare("UPDATE field_action_media SET r2_stored_at = '2026-08-20T10:01:00.000Z'").run();
  const second = await deriveNativeFinalInvoiceForJob(
    drifted.env,
    {
      tenantId: TENANT,
      roofJobId: JOB,
    },
    DERIVE_AT,
  );
  assert.equal(second.outcome, "blocked");
  if (second.outcome === "blocked") {
    assert.equal(second.blocker_code, "work_package_evidence_changed_after_completion");
  }
});

test("unresolved prior billing blocks while an exact full prior balance yields no new invoice", async () => {
  const unresolved = nativeTestEnv();
  seedNativeSource(unresolved.db);
  await seedPriorInvoice(unresolved.env, undefined, false);
  const blockedResult = await deriveNativeFinalInvoiceForJob(
    unresolved.env,
    {
      tenantId: TENANT,
      roofJobId: JOB,
    },
    DERIVE_AT,
  );
  assert.equal(blockedResult.outcome, "blocked");
  if (blockedResult.outcome === "blocked") {
    assert.equal(blockedResult.blocker_code, "prior_invoice_truth_unresolved");
  }

  const paid = nativeTestEnv();
  seedNativeSource(paid.db);
  await seedPriorInvoice(paid.env, {
    subtotal: "2000.00",
    tax: "100.00",
    total: "2100.00",
  });
  const noBalance = await deriveNativeFinalInvoiceForJob(
    paid.env,
    {
      tenantId: TENANT,
      roofJobId: JOB,
    },
    DERIVE_AT,
  );
  assert.equal(noBalance.outcome, "no_balance");
  assert.equal(
    Number(
      (
        paid.db.raw
          .prepare("SELECT COUNT(*) AS count FROM accounting_intents WHERE final_invoice_intent_id IS NOT NULL")
          .get() as any
      ).count,
    ),
    0,
  );
});

test("a prior provider payload in another currency never reduces the CAD contract balance", async () => {
  const { env, db } = nativeTestEnv();
  seedNativeSource(db);
  await seedPriorInvoice(env, { subtotal: "500.00", tax: "25.00", total: "525.00" }, true, "USD");
  const result = await deriveNativeFinalInvoiceForJob(
    env,
    {
      tenantId: TENANT,
      roofJobId: JOB,
    },
    DERIVE_AT,
  );
  assert.equal(result.outcome, "blocked");
  if (result.outcome === "blocked") {
    assert.equal(result.blocker_code, "prior_invoice_provider_evidence_invalid");
  }
});

test("provider mappings are immutable version chains and never overwrite prior evidence", async () => {
  const { env, db } = nativeTestEnv();
  seedNativeSource(db);
  const anchor = await currentCommercialAnchor(db);
  const first = await recordNativeFinalInvoiceProviderBinding(
    env,
    {
      tenantId: TENANT,
      realmId: REALM,
      roofJobId: JOB,
      qboCustomerId: "7",
      qboItemId: "8",
      qboTaxCodeId: "10",
      qboTermsId: "9",
      jurisdiction: "CA-AB",
      taxCode: "GST",
      paymentTermsDays: 30,
      sourceRef: "owner-approved-provider-map:0001",
      sourceSha256: "1".repeat(64),
      ...anchor,
    },
    DERIVE_AT,
  );
  const replay = await recordNativeFinalInvoiceProviderBinding(
    env,
    {
      tenantId: TENANT,
      realmId: REALM,
      roofJobId: JOB,
      qboCustomerId: "7",
      qboItemId: "8",
      qboTaxCodeId: "10",
      qboTermsId: "9",
      jurisdiction: "CA-AB",
      taxCode: "GST",
      paymentTermsDays: 30,
      sourceRef: "owner-approved-provider-map:0001",
      sourceSha256: "1".repeat(64),
      ...anchor,
    },
    DERIVE_AT,
  );
  assert.equal(replay.provider_binding_id, first.provider_binding_id);
  await assert.rejects(
    () =>
      recordNativeFinalInvoiceProviderBinding(
        env,
        {
          tenantId: TENANT,
          realmId: REALM,
          roofJobId: JOB,
          qboCustomerId: "7",
          qboItemId: "88",
          qboTaxCodeId: "10",
          qboTermsId: "9",
          jurisdiction: "CA-AB",
          taxCode: "GST",
          paymentTermsDays: 30,
          sourceRef: "owner-approved-provider-map:0002",
          sourceSha256: "2".repeat(64),
          ...anchor,
        },
        DERIVE_AT,
      ),
    /native_final_invoice_provider_binding_correction_required/,
  );
  const corrected = await recordNativeFinalInvoiceProviderBinding(
    env,
    {
      tenantId: TENANT,
      realmId: REALM,
      roofJobId: JOB,
      qboCustomerId: "7",
      qboItemId: "88",
      qboTaxCodeId: "10",
      qboTermsId: "9",
      jurisdiction: "CA-AB",
      taxCode: "GST",
      paymentTermsDays: 30,
      sourceRef: "owner-approved-provider-map:0002",
      sourceSha256: "2".repeat(64),
      ...anchor,
      correctionReason: "Correct the explicitly reviewed roofing item mapping.",
    },
    DERIVE_AT,
  );
  assert.equal(corrected.binding_version, 2);
  assert.equal(corrected.supersedes_binding_id, first.provider_binding_id);
  const mapping = await readNativeInitialProviderMapping(env, TENANT, JOB);
  assert.equal(mapping.status, "found");
  if (mapping.status === "found") {
    assert.equal(mapping.value.provider_binding_id, corrected.provider_binding_id);
    assert.equal(mapping.value.qbo_item_id, "88");
  }
  assert.equal(
    (await readNativeInitialProviderMapping(env, TENANT, "job-unmapped-0001")).status,
    "missing",
  );
  assert.throws(
    () =>
      db.raw
        .prepare("UPDATE native_final_invoice_provider_bindings SET qbo_item_id = '99' WHERE provider_binding_id = ?")
        .run(first.provider_binding_id),
    /native_final_invoice_provider_bindings_append_only/,
  );
});

test("provider mappings require commercial anchors even when TypeScript is bypassed", () => {
  const { db } = nativeTestEnv();
  seedNativeSource(db);
  assert.throws(
    () =>
      db.raw
        .prepare(
          `INSERT INTO native_final_invoice_provider_bindings (
             provider_binding_id, tenant_id, realm_id, roof_job_id, binding_version,
             qbo_customer_id, qbo_item_id, qbo_tax_code_id, qbo_terms_id, jurisdiction,
             tax_code, payment_terms_days, source_ref, source_sha256, recorded_at
           ) VALUES (?, ?, ?, ?, 1, '7', '8', '10', '9', 'CA-AB', 'GST', 30, ?, ?, ?)`,
        )
        .run(
          "nfpb_missing_commercial_anchor_0001",
          TENANT,
          REALM,
          JOB,
          "provider-readback-without-commercial-anchor",
          "1".repeat(64),
          DERIVE_AT.toISOString(),
        ),
    /native_final_invoice_provider_binding_commercial_anchor_required/,
  );
});

test("a changed accepted commercial head blocks a previously verified provider mapping", async () => {
  const { env, db } = nativeTestEnv();
  seedNativeSource(db);
  await seedPriorInvoice(env);
  const anchor = await currentCommercialAnchor(db);
  await recordNativeFinalInvoiceProviderBinding(
    env,
    {
      tenantId: TENANT,
      realmId: REALM,
      roofJobId: JOB,
      qboCustomerId: "7",
      qboItemId: "8",
      qboTaxCodeId: "10",
      qboTermsId: "9",
      jurisdiction: "CA-AB",
      taxCode: "GST",
      paymentTermsDays: 30,
      sourceRef: "owner-approved-provider-map:stale-commercial-head",
      sourceSha256: "3".repeat(64),
      ...anchor,
    },
    DERIVE_AT,
  );
  db.raw.prepare("UPDATE commercial_quote_revisions SET terms_hash = ? WHERE tenant_id = ?").run("e".repeat(64), TENANT);
  db.raw.prepare("UPDATE commercial_proposal_revisions SET terms_hash = ? WHERE tenant_id = ?").run("e".repeat(64), TENANT);
  db.raw.prepare("UPDATE commercial_acceptance_bindings SET terms_hash = ? WHERE tenant_id = ?").run("e".repeat(64), TENANT);
  const derived = await deriveNativeFinalInvoiceForJob(
    env,
    { tenantId: TENANT, roofJobId: JOB },
    DERIVE_AT,
  );
  assert.equal(derived.outcome, "blocked");
  if (derived.outcome === "blocked") {
    assert.equal(derived.blocker_code, "provider_mapping_commercial_head_changed");
  }
});

test("a corrected provider basis blocks a second final invoice instead of duplicating the receivable", async () => {
  const { env, db } = nativeTestEnv();
  seedNativeSource(db);
  await seedPriorInvoice(env);

  const first = await deriveNativeFinalInvoiceForJob(
    env,
    {
      tenantId: TENANT,
      roofJobId: JOB,
    },
    DERIVE_AT,
  );
  assert.equal(first.outcome, "intent_derived");

  const current = db.raw
    .prepare(
      `SELECT * FROM native_final_invoice_provider_bindings
      WHERE tenant_id = ? AND roof_job_id = ? AND supersedes_binding_id IS NULL`,
    )
    .get(TENANT, JOB) as Record<string, unknown>;
  await recordNativeFinalInvoiceProviderBinding(
    env,
    {
      tenantId: TENANT,
      realmId: String(current.realm_id),
      roofJobId: JOB,
      qboCustomerId: String(current.qbo_customer_id),
      qboItemId: "88",
      qboTaxCodeId: String(current.qbo_tax_code_id),
      qboTermsId: String(current.qbo_terms_id),
      jurisdiction: String(current.jurisdiction),
      taxCode: String(current.tax_code),
      paymentTermsDays: Number(current.payment_terms_days),
      sourceRef: "owner-approved-provider-map:corrected-item",
      sourceSha256: "9".repeat(64),
      commercialTermsHash: String(current.commercial_terms_hash),
      commercialHeadSha256: String(current.commercial_head_sha256),
      correctionReason: "Use the reviewed final-invoice roofing item.",
    },
    new Date("2026-08-21T12:01:00.000Z"),
  );

  const second = await deriveNativeFinalInvoiceForJob(
    env,
    {
      tenantId: TENANT,
      roofJobId: JOB,
    },
    new Date("2026-08-21T12:02:00.000Z"),
  );
  assert.equal(second.outcome, "blocked");
  if (second.outcome === "blocked") {
    assert.equal(second.blocker_code, "existing_final_invoice_requires_reconciliation");
  }
  assert.equal(
    Number(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS count FROM accounting_intents WHERE final_invoice_intent_id IS NOT NULL")
          .get() as { count: number }
      ).count,
    ),
    1,
  );
});

test("independent commercial heads block final derivation and stale an already reconciled final invoice", async () => {
  const { env, db } = nativeTestEnv();
  seedNativeSource(db);
  await seedPriorInvoice(env);

  const first = await deriveNativeFinalInvoiceForJob(
    env,
    { tenantId: TENANT, roofJobId: JOB },
    DERIVE_AT,
  );
  assert.equal(first.outcome, "intent_derived");
  if (first.outcome !== "intent_derived") return;

  const intent = db.raw
    .prepare("SELECT * FROM accounting_intents WHERE intent_id = ?")
    .get(first.accounting_intent_id) as AccountingIntentRecord;
  const approved = await applyAccountingIntentCommand(
    env,
    {
      tenantId: TENANT,
      intentId: intent.intent_id,
      operation: "approve",
      actorUserId: "appu_accounting_0001",
      idempotencyKey: "approve-independent-head-final-0001",
      request: { intent_id: intent.intent_id },
      requestedVersion: intent.version,
    },
    DERIVE_AT,
  );
  assert.equal(approved.intent.state, "submission_pending");

  const basis = JSON.parse(intent.basis_json) as {
    commercial: { subtotal: string; tax_amount: string; total_amount: string; lines: unknown[] };
    qbo: { customer_id: string; item_id: string; tax_code_id: string; terms_id: string };
  };
  const providerPayload = nativeFinalInvoiceProviderPayload(basis as never);
  const observedInvoice = {
    ...providerPayload,
    Id: "2002",
    TotalAmt: Number(basis.commercial.total_amount),
    Balance: 0,
    TxnTaxDetail: { TotalTax: Number(basis.commercial.tax_amount) },
    Line: [
      ...(providerPayload.Line as unknown[]),
      {
        Amount: Number(basis.commercial.subtotal),
        DetailType: "SubTotalLineDetail",
        SubTotalLineDetail: {},
      },
    ],
  };
  const payment = {
    Id: "3002",
    CustomerRef: { value: basis.qbo.customer_id },
    CurrencyRef: { value: "CAD" },
    TxnDate: "2026-08-21",
    TotalAmt: Number(basis.commercial.total_amount),
    UnappliedAmt: 0,
    Line: [{
      Amount: Number(basis.commercial.total_amount),
      LinkedTxn: [{ TxnId: "2002", TxnType: "Invoice" }],
    }],
  };
  await recordAccountingObservation(
    env,
    {
      tenantId: TENANT,
      realmId: REALM,
      entityType: "Payment",
      normalized: normalizeProviderEntity({ realmId: REALM, entityType: "Payment", payload: payment }),
      payload: payment,
      readAt: "2026-08-21T12:02:00.000Z",
      source: "recovery_query",
    },
    DERIVE_AT,
  );
  await recordAccountingIntentSubmission(
    env,
    {
      tenantId: TENANT,
      intentId: intent.intent_id,
      outcome: {
        effectId: "effect-independent-head-final-0001",
        state: "succeeded",
        attemptId: "attempt-independent-head-final-0001",
        attemptState: "succeeded",
        providerExternalId: "2002",
        requestHash: "d".repeat(64),
        providerResponseHash: "e".repeat(64),
        readbackHash: "f".repeat(64),
        resultCode: null,
      },
    },
    new Date("2026-08-21T12:02:30.000Z"),
  );
  const reconciled = await reconcileAccountingIntent(
    env,
    {
      tenantId: TENANT,
      intentId: intent.intent_id,
      read: {
        status: "ok",
        realmId: REALM,
        entityType: "Invoice",
        entityId: "2002",
        payload: observedInvoice,
        normalized: normalizeProviderEntity({ realmId: REALM, entityType: "Invoice", payload: observedInvoice }),
        readAt: "2026-08-21T12:03:00.000Z",
        source: "dispatch_readback",
        effectAttemptId: "attempt-independent-head-final-0001",
      },
    },
    new Date("2026-08-21T12:03:30.000Z"),
  );
  assert.equal(reconciled.verdict, "reconciled");
  const settled = db.raw
    .prepare("SELECT * FROM accounting_intents WHERE intent_id = ?")
    .get(intent.intent_id) as AccountingIntentRecord;
  assert.equal(await isNativeFinalInvoiceCurrent(env, settled), true);

  db.raw
    .prepare(
      `INSERT INTO commercial_quote_revisions (
         quote_revision_id, tenant_id, customer_quote_id, revision_number, roof_job_id,
         customer_id, status, currency, subtotal_cents, tax_cents, total_cents, terms_hash,
         created_at
       ) VALUES ('quote-rev-independent-0001', ?, 'quote-pack-independent-0001', 1, ?, ?,
         'approved', 'CAD', 200000, 10000, 210000, ?, '2026-08-19T08:00:00.000Z')`,
    )
    .run(TENANT, JOB, CUSTOMER, "b".repeat(64));
  db.raw
    .prepare(
      `INSERT INTO commercial_proposal_revisions (
         proposal_revision_id, tenant_id, proposal_pack_id, revision_number, quote_revision_id,
         roof_job_id, customer_id, terms_hash, created_at
       ) VALUES ('proposal-rev-independent-0001', ?, 'proposal-pack-independent-0001', 1,
         'quote-rev-independent-0001', ?, ?, ?, '2026-08-19T09:00:00.000Z')`,
    )
    .run(TENANT, JOB, CUSTOMER, "b".repeat(64));

  const stale = await isNativeFinalInvoiceCurrent(env, settled);
  assert.equal(stale, false);
  const blocked = await deriveNativeFinalInvoiceForJob(
    env,
    { tenantId: TENANT, roofJobId: JOB },
    new Date("2026-08-21T12:04:00.000Z"),
  );
  assert.equal(blocked.outcome, "blocked");
  if (blocked.outcome === "blocked") assert.equal(blocked.blocker_code, "commercial_head_changed");
});

test("approval fails closed when native completion truth changes after derivation", async () => {
  const { env, db } = nativeTestEnv();
  seedNativeSource(db);
  await seedPriorInvoice(env);
  const derived = await deriveNativeFinalInvoiceForJob(
    env,
    {
      tenantId: TENANT,
      roofJobId: JOB,
    },
    DERIVE_AT,
  );
  assert.equal(derived.outcome, "intent_derived");
  if (derived.outcome !== "intent_derived") return;

  const before = await listNativeFinalInvoiceCandidates(env, {
    tenantId: TENANT,
    realmId: REALM,
    roofJobId: JOB,
    limit: 10,
  });
  assert.equal(before.blockers.length, 0);
  assert.equal(before.candidates.length, 1);
  const candidate = before.candidates[0]!;
  const intent = db.raw
    .prepare("SELECT * FROM accounting_intents WHERE intent_id = ?")
    .get(derived.accounting_intent_id) as Record<string, unknown>;
  const candidateFingerprintSha256 = await sha256Hex(canonicalJson(candidate));

  db.raw.prepare("UPDATE work_packages SET status = 'In Progress' WHERE work_package_id = ?").run(PACKAGE);

  const after = await listNativeFinalInvoiceCandidates(env, {
    tenantId: TENANT,
    realmId: REALM,
    roofJobId: JOB,
    limit: 10,
  });
  assert.equal(after.candidates.length, 0);
  assert.equal(after.blockers[0]?.code, "native_final_invoice_basis_invalid");
  await assert.rejects(
    () =>
      approveNativeFinalInvoice(env, {
        tenantId: TENANT,
        intentId: derived.accounting_intent_id,
        roofJobId: JOB,
        realmId: REALM,
        basisSha256: String(intent.basis_sha256),
        providerPayloadSha256: String(intent.provider_payload_sha256),
        providerRequestId: String(intent.provider_request_id),
        candidateFingerprintSha256,
        actorUserId: "appu_accounting_0001",
        idempotencyKey: "approve-stale-final-0001",
        now: new Date("2026-08-21T12:03:00.000Z"),
      }),
    /native_final_invoice_basis_changed/,
  );
  assert.equal(
    (
      db.raw.prepare("SELECT state FROM accounting_intents WHERE intent_id = ?").get(derived.accounting_intent_id) as {
        state: string;
      }
    ).state,
    "pending_review",
  );
});

test("bounded scheduled derivation rotates past stable blockers and wraps without starvation", async () => {
  const { env, db } = nativeTestEnv();
  for (const suffix of ["0001", "0002", "0003"]) {
    const jobId = `job-native-cursor-${suffix}`;
    db.raw
      .prepare(
        `INSERT INTO operating_roof_jobs
         (roof_job_id, tenant_id, customer_id, version, job_status, updated_at)
       VALUES (?, ?, ?, 1, 'in_progress', ?)`,
      )
      .run(jobId, TENANT, `customer-native-${suffix}`, COMPLETE_AT);
    db.raw
      .prepare(
        `INSERT INTO work_packages (
         work_package_id, tenant_id, version, job_id, assignment_id, work_object_type,
         work_object_id, physical_context_type, physical_context_id, status, definition_json,
         completed_at, updated_at
       ) VALUES (?, ?, 1, ?, 'missing-assignment', 'Roof Job', ?, 'Roof Site', ?,
         'In Progress', '{}', NULL, ?)`,
      )
      .run(`package-native-cursor-${suffix}`, TENANT, jobId, jobId, jobId, COMPLETE_AT);
  }

  const visited: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const result = await deriveNativeFinalInvoiceIntents(env, new Date(DERIVE_AT.getTime() + index * 60_000), 1);
    assert.deepEqual(result, {
      scanned: 1,
      blocked: 1,
      no_balance: 0,
      intents_derived: 0,
      intents_replayed: 0,
    });
    visited.push(
      (
        db.raw
          .prepare(
            `SELECT last_roof_job_id FROM native_final_invoice_derivation_cursors
        WHERE cursor_name = 'scheduled-v1'`,
          )
          .get() as { last_roof_job_id: string }
      ).last_roof_job_id,
    );
  }
  assert.deepEqual(visited, [
    "job-native-cursor-0001",
    "job-native-cursor-0002",
    "job-native-cursor-0003",
    "job-native-cursor-0001",
  ]);
});

// ------------------------------------------------------------------ OD-01: payment on completion
//
// Under OD-01 a contract has no deposit, so no deposit invoice is derived at acceptance (proved at
// D1 in customer-contract-acceptance.test.ts). The producer subtracts prior invoices only, so the
// final invoice must bill the whole contract: these cases prove it on the real producer, and that
// a deposit invoice of a contract OD-01 replaced is never subtracted unless it still stands.

/** The accepted contract's terms: its quote carries them, and its proposal and acceptance their hash. */
async function bindContractTerms(
  db: AccountingTestD1,
  head: typeof FIRST_CONTRACT,
  terms: Record<string, unknown>,
): Promise<void> {
  const termsJson = JSON.stringify(terms);
  const termsHash = await sha256Hex(termsJson);
  db.raw
    .prepare("UPDATE commercial_quote_revisions SET terms_json = ?, terms_hash = ? WHERE quote_revision_id = ?")
    .run(termsJson, termsHash, head.quote);
  db.raw
    .prepare("UPDATE commercial_proposal_revisions SET terms_hash = ? WHERE proposal_revision_id = ?")
    .run(termsHash, head.proposal);
  db.raw
    .prepare("UPDATE commercial_acceptance_bindings SET terms_hash = ? WHERE acceptance_binding_id = ?")
    .run(termsHash, head.acceptance);
}

/**
 * Revision 2 of the same quote and proposal replaces the first contract with OD-01 terms and a new
 * price (2200.00 + 110.00 GST), published and accepted after it.
 */
async function acceptOd01Replacement(db: AccountingTestD1): Promise<void> {
  const termsJson = JSON.stringify(OD01_TERMS);
  const termsHash = await sha256Hex(termsJson);
  db.raw
    .prepare(
      `INSERT INTO commercial_quote_revisions (
         quote_revision_id, tenant_id, customer_quote_id, revision_number, roof_job_id,
         customer_id, supersedes_quote_revision_id, status, currency, subtotal_cents, tax_cents,
         total_cents, terms_hash, terms_json, created_at
       ) VALUES (?, ?, 'quote-pack-0001', 2, ?, ?, ?, 'approved', 'CAD', 220000, 11000, 231000, ?, ?,
         '2026-08-19T12:00:00.000Z')`,
    )
    .run(OD01_CONTRACT.quote, TENANT, JOB, CUSTOMER, FIRST_CONTRACT.quote, termsHash, termsJson);
  db.raw
    .prepare(
      `INSERT INTO commercial_quote_lines (
         quote_revision_id, line_id, sequence, subtotal_cents, tax_code, tax_cents, total_cents
       ) VALUES (?, 'line-roof-0002', 1, 220000, 'GST', 11000, 231000)`,
    )
    .run(OD01_CONTRACT.quote);
  db.raw
    .prepare(
      `INSERT INTO commercial_proposal_revisions (
         proposal_revision_id, tenant_id, proposal_pack_id, revision_number, quote_revision_id,
         roof_job_id, customer_id, supersedes_proposal_revision_id, terms_hash, created_at
       ) VALUES (?, ?, 'proposal-pack-0001', 2, ?, ?, ?, ?, ?, '2026-08-19T12:30:00.000Z')`,
    )
    .run(OD01_CONTRACT.proposal, TENANT, OD01_CONTRACT.quote, JOB, CUSTOMER, FIRST_CONTRACT.proposal, termsHash);
  db.raw
    .prepare(
      `INSERT INTO commercial_proposal_publication_events (
         publication_event_id, tenant_id, proposal_revision_id, proposal_pack_id,
         publication_version, state, occurred_at
       ) VALUES (?, ?, ?, 'proposal-pack-0001', 2, 'published', '2026-08-19T13:00:00.000Z')`,
    )
    .run(OD01_CONTRACT.publication, TENANT, OD01_CONTRACT.proposal);
  db.raw
    .prepare(
      `INSERT INTO commercial_acceptance_bindings (
         acceptance_binding_id, acceptance_id, tenant_id, quote_revision_id,
         proposal_revision_id, roof_job_id, customer_id, terms_hash, receipt_hash,
         accepted_at, bound_at
       ) VALUES (?, 'acceptance-native-0002', ?, ?, ?, ?, ?, ?, ?, '2026-08-19T14:00:00.000Z',
         '2026-08-19T14:01:00.000Z')`,
    )
    .run(
      OD01_CONTRACT.acceptance,
      TENANT,
      OD01_CONTRACT.quote,
      OD01_CONTRACT.proposal,
      JOB,
      CUSTOMER,
      termsHash,
      "d".repeat(64),
    );
}

async function recordGstSnapshot(env: AppEnv): Promise<void> {
  await recordTaxPolicySnapshot(
    env,
    {
      tenantId: TENANT,
      jurisdiction: "CA-AB",
      taxCode: "GST",
      providerTaxCodeId: "10",
      ratePercent: "5.0000",
      effectiveFrom: "2026-01-01",
      sourceRef: "CRA GST policy snapshot 2026-01-01",
    },
    NOW,
  );
}

/**
 * The owner's verified QuickBooks mapping for the job, anchored to the contract in force. With no
 * prior invoice to read it from, an OD-01 job always needs one, or the producer blocks with
 * `provider_mapping_missing`.
 */
async function recordProviderMapping(env: AppEnv, db: AccountingTestD1, head = FIRST_CONTRACT): Promise<void> {
  await recordNativeFinalInvoiceProviderBinding(
    env,
    {
      tenantId: TENANT,
      realmId: REALM,
      roofJobId: JOB,
      qboCustomerId: "7",
      qboItemId: "8",
      qboTaxCodeId: "10",
      qboTermsId: "9",
      jurisdiction: "CA-AB",
      taxCode: "GST",
      paymentTermsDays: 30,
      sourceRef: "owner-approved-provider-map:od01",
      sourceSha256: "5".repeat(64),
      ...(await currentCommercialAnchor(db, head)),
    },
    DERIVE_AT,
  );
}

/** The job's one final invoice: the row, its basis and the payload QuickBooks would receive. */
function finalInvoice(db: AccountingTestD1): {
  row: Record<string, unknown>;
  basis: Record<string, any>;
  payload: Record<string, any>;
} {
  const rows = db.raw
    .prepare("SELECT * FROM accounting_intents WHERE final_invoice_intent_id = intent_id")
    .all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  return {
    row,
    basis: JSON.parse(String(row.basis_json)) as Record<string, any>,
    payload: JSON.parse(String(row.provider_payload_json)) as Record<string, any>,
  };
}

/** The intents a blocked derivation names, from its durable observation. */
function blockedIntents(db: AccountingTestD1, observationId: string): unknown {
  const observation = db.raw
    .prepare("SELECT details_json FROM native_final_invoice_derivation_observations WHERE derivation_observation_id = ?")
    .get(observationId) as { details_json: string };
  return (JSON.parse(observation.details_json) as { facts: { blocker: { intents: unknown } } }).facts.blocker.intents;
}

test("an OD-01 contract's final invoice bills the whole contract with its tax and credits no deposit", async () => {
  const { env, db } = nativeTestEnv();
  seedNativeSource(db);
  await bindContractTerms(db, FIRST_CONTRACT, OD01_TERMS);
  await recordGstSnapshot(env);
  await recordProviderMapping(env, db);

  // The scheduled producer, as the cron runs it.
  assert.deepEqual(await deriveNativeFinalInvoiceIntents(env, DERIVE_AT), {
    scanned: 1,
    blocked: 0,
    no_balance: 0,
    intents_derived: 1,
    intents_replayed: 0,
  });
  const { row, basis, payload } = finalInvoice(db);
  const contract = db.raw
    .prepare("SELECT subtotal_cents, tax_cents, total_cents FROM commercial_quote_revisions WHERE quote_revision_id = ?")
    .get(FIRST_CONTRACT.quote) as { subtotal_cents: number; tax_cents: number; total_cents: number };
  const dollars = (cents: number) => (cents / 100).toFixed(2);
  // The whole contract, tax included: 2000.00 + 100.00 GST = 2100.00.
  assert.deepEqual(
    { kind: row.kind, subtotal: row.subtotal, tax: row.tax_amount, total: row.total_amount },
    {
      kind: "progress_invoice",
      subtotal: dollars(contract.subtotal_cents),
      tax: dollars(contract.tax_cents),
      total: dollars(contract.total_cents),
    },
  );
  assert.equal(row.total_amount, "2100.00");
  // Nothing credited: no prior invoice, one contract line, no deposit line and no negative line.
  assert.equal(basis.commercial.already_invoiced, "0.00");
  assert.equal(basis.commercial.final_balance, "2100.00");
  assert.deepEqual(basis.prior_invoices, []);
  assert.deepEqual(basis.commercial.lines, [
    {
      source_type: "Customer Quote",
      source_id: FIRST_CONTRACT.quote,
      source_version: 1,
      description_code: "RESIDENTIAL_ACCEPTED_QUOTE",
      amount: "2000.00",
    },
  ]);
  assert.deepEqual(
    (basis.evidence as Array<{ doctype: string }>).filter((citation) => citation.doctype === "Accounting Intent"),
    [],
  );
  assert.deepEqual(
    (payload.Line as Array<{ Amount: number; Description: string }>).map((line) => [line.Amount, line.Description]),
    [[2000, "Residential roofing contract"]],
  );
  assert.doesNotMatch(JSON.stringify({ basis, payload }), /deposit/i);
  assert.deepEqual(
    (db.raw.prepare("SELECT kind FROM accounting_intents").all() as Array<{ kind: string }>).map((intent) => intent.kind),
    ["progress_invoice"],
  );
  // The accountant's queue shows the same balance.
  const listing = await listNativeFinalInvoiceCandidates(env, {
    tenantId: TENANT,
    realmId: REALM,
    roofJobId: JOB,
    limit: 10,
  });
  assert.deepEqual(listing.blockers, []);
  assert.equal(listing.candidates.length, 1);
  assert.equal(listing.candidates[0]!.commercial.already_invoiced, "0.00");
  assert.equal(listing.candidates[0]!.commercial.final_balance, "2100.00");
});

test("an OD-01 contract replacing a deposit contract whose deposit invoice was never issued bills its whole new total", async () => {
  // The replaced contract's deposit invoice was never derived: nothing to subtract.
  {
    const { env, db } = nativeTestEnv();
    seedNativeSource(db);
    await bindContractTerms(db, FIRST_CONTRACT, DEPOSIT_TERMS);
    await acceptOd01Replacement(db);
    await recordGstSnapshot(env);
    await recordProviderMapping(env, db, OD01_CONTRACT);
    const derived = await deriveNativeFinalInvoiceForJob(env, { tenantId: TENANT, roofJobId: JOB }, DERIVE_AT);
    assert.equal(derived.outcome, "intent_derived");
    const { row, basis } = finalInvoice(db);
    assert.deepEqual([row.subtotal, row.tax_amount, row.total_amount], ["2200.00", "110.00", "2310.00"]);
    assert.equal(basis.accepted_quote.id, OD01_CONTRACT.quote);
    assert.equal(basis.commercial.already_invoiced, "0.00");
    assert.deepEqual(basis.prior_invoices, []);
  }
  // It was derived but never approved, so it could still be issued: the producer stops and names
  // it. Once a person rejects it, which cancels it before QuickBooks, it is left out entirely.
  {
    const { env, db } = nativeTestEnv();
    seedNativeSource(db);
    await bindContractTerms(db, FIRST_CONTRACT, DEPOSIT_TERMS);
    await seedPriorInvoice(env, undefined, false);
    await acceptOd01Replacement(db);
    await recordProviderMapping(env, db, OD01_CONTRACT);
    const pending = await deriveNativeFinalInvoiceForJob(env, { tenantId: TENANT, roofJobId: JOB }, DERIVE_AT);
    assert.equal(pending.outcome, "blocked");
    if (pending.outcome === "blocked") {
      assert.equal(pending.blocker_code, "prior_invoice_truth_unresolved");
      assert.deepEqual(blockedIntents(db, pending.observation_id), [
        { intent_id: "acct-prior-deposit-0001", state: "pending_review" },
      ]);
    }
    const deposit = db.raw
      .prepare("SELECT version FROM accounting_intents WHERE intent_id = 'acct-prior-deposit-0001'")
      .get() as { version: number };
    const rejected = await applyAccountingIntentCommand(
      env,
      {
        tenantId: TENANT,
        intentId: "acct-prior-deposit-0001",
        operation: "reject",
        actorUserId: "appu_accounting_0001",
        idempotencyKey: "reject-replaced-contract-deposit-0001",
        request: { intent_id: "acct-prior-deposit-0001" },
        requestedVersion: deposit.version,
      },
      DERIVE_AT,
    );
    assert.equal(rejected.intent.state, "rejected");
    const derived = await deriveNativeFinalInvoiceForJob(
      env,
      { tenantId: TENANT, roofJobId: JOB },
      new Date(DERIVE_AT.getTime() + 60_000),
    );
    assert.equal(derived.outcome, "intent_derived");
    const { row, basis } = finalInvoice(db);
    assert.deepEqual([row.subtotal, row.tax_amount, row.total_amount], ["2200.00", "110.00", "2310.00"]);
    assert.equal(basis.commercial.already_invoiced, "0.00");
    assert.deepEqual(basis.prior_invoices, []);
    assert.ok(!JSON.stringify(basis).includes("acct-prior-deposit-0001"));
  }
});

test("a deposit invoice reversed after it reached QuickBooks is never subtracted: the producer stops for a person", async () => {
  const { env, db } = nativeTestEnv();
  seedNativeSource(db);
  await bindContractTerms(db, FIRST_CONTRACT, DEPOSIT_TERMS);
  // Issued in QuickBooks and read back, then reversed by the money lane. A reversal answers a
  // provider duplicate, surplus or mismatch, so whether the original still bills is not in the
  // intent: excluding it could bill twice and subtracting it could bill short.
  await seedPriorInvoice(env);
  for (const state of ["reconciliation_required", "compensating", "compensated"]) {
    db.raw
      .prepare(
        `UPDATE accounting_intents SET state = ?, version = version + 1, updated_at = ?
          WHERE intent_id = 'acct-prior-deposit-0001'`,
      )
      .run(state, "2026-08-21T11:00:00.000Z");
  }
  await acceptOd01Replacement(db);
  await recordProviderMapping(env, db, OD01_CONTRACT);
  const derived = await deriveNativeFinalInvoiceForJob(env, { tenantId: TENANT, roofJobId: JOB }, DERIVE_AT);
  assert.equal(derived.outcome, "blocked");
  if (derived.outcome === "blocked") {
    assert.equal(derived.blocker_code, "prior_invoice_truth_unresolved");
    assert.deepEqual(blockedIntents(db, derived.observation_id), [
      { intent_id: "acct-prior-deposit-0001", state: "compensated" },
    ]);
  }
  assert.equal(
    Number(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS count FROM accounting_intents WHERE final_invoice_intent_id IS NOT NULL")
          .get() as { count: number }
      ).count,
    ),
    0,
  );
});
