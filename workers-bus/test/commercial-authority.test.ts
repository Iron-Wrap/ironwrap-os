import { activateCatalogRevision, createCatalogRevision } from "../src/pricing-catalog.ts";
import { catalogList } from "./pricing-catalog-fixture.ts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import {
  admitCommercialPermit,
  commercialEffectAuthority,
  type CommercialAction,
  type CommercialPermitRecord,
} from "../src/commercial-authority.ts";
import type { AppEnv } from "../src/app-types.ts";
import {
  bindCommercialCustomerAcceptance,
  buildCommercialPublicationCommand,
  buildLeadTriageCommand,
  CommercialStoreError,
  getCommercialAcceptanceForJob,
  getCurrentCommercialProposal,
  getCurrentCommercialPublication,
  getCurrentCommercialQuote,
  prepareCommercialProposal,
  prepareCommercialQuote,
  recordCommercialProposalPublication,
  recordCommercialProposalRevision,
  recordCommercialQuoteRevision,
  recordLeadTriageDecision,
  type RecordCommercialProposalInput,
  type RecordCommercialPublicationInput,
  type RecordCommercialQuoteInput,
  type RecordLeadTriageInput,
} from "../src/commercial-store.ts";
import { runExternalEffect } from "../src/effect-runtime.ts";
import { recordDepositPolicy } from "./deposit-policy-fixture.ts";

const TENANT = "ironwrap";
const NOW = new Date("2026-08-20T12:00:00.000Z");
const OWNER_ID = "appu_owner_0001";
const ENVELOPE_ID = "ow_commercial_0001";
const LEAD_ID = "lead:commercial:0001";
const CUSTOMER_ID = "customer:commercial:0001";
const JOB_ID = "job:commercial:0001";
const QUOTE_REVISION_ID = "quote-revision:commercial:0001";
const QUOTE_ID = "customer-quote:commercial:0001";
const PROPOSAL_REVISION_ID = "proposal-revision:commercial:0001";
const PROPOSAL_PACK_ID = "proposal-pack:commercial:0001";
const EVIDENCE = [{ ref: "r2://commercial/evidence/0001.json", sha256: "a".repeat(64) }] as const;
const TERMS = {
  deposit_percent: 25,
  payment_schedule: ["deposit", "completion"],
  payment_terms_days: 30,
  warranty_years: 10,
};

test("activating catalog B preserves previously recorded quote cents and every quote line byte", async () => {
  const db = new SqliteD1(),
    env = commercialEnv(db);
  try {
    db.raw
      .prepare(
        "UPDATE operating_leads SET lifecycle_status='qualified',version=version+1 WHERE lead_id=?",
      )
      .run(LEAD_ID);
    const request = quoteRequest(),
      prepared = await prepareCommercialQuote(request);
    const permit = await admitFor(
      env,
      "quote.revision.record",
      { type: "customer_quote", id: QUOTE_ID, version: 1 },
      prepared.command,
      "permit:catalog-quote:0001",
      prepared.totalCents,
    );
    request.authority = { kind: "policy_permit", permitId: permit.permit_id };
    const stored = await recordCommercialQuoteRevision(env, request, at(2));
    const before = JSON.stringify({
      quotes: db.raw
        .prepare(
          "SELECT * FROM commercial_quote_revisions ORDER BY quote_revision_id",
        )
        .all(),
      lines: db.raw
        .prepare(
          "SELECT * FROM commercial_quote_lines ORDER BY quote_revision_id,sequence",
        )
        .all(),
    });
    const actor = { tenantId: TENANT, userId: OWNER_ID, role: "owner" };
    for (let revision = 1; revision <= 2; revision++) {
      const catalog = await createCatalogRevision(
        env,
        actor,
        {
          label: `Synthetic catalog ${revision}`,
          price_list: catalogList(revision, revision * 1000),
        },
        `pricing:quote:create-${revision}`,
        at(3),
      );
      await activateCatalogRevision(
        env,
        actor,
        {
          revision_id: catalog.revision.revision_id,
          reviewed_sha256: catalog.revision.snapshot_sha256,
          expected_version: revision - 1,
        },
        `pricing:quote:approve-${revision}`,
        at(4),
      );
    }
    const after = JSON.stringify({
      quotes: db.raw
        .prepare(
          "SELECT * FROM commercial_quote_revisions ORDER BY quote_revision_id",
        )
        .all(),
      lines: db.raw
        .prepare(
          "SELECT * FROM commercial_quote_lines ORDER BY quote_revision_id,sequence",
        )
        .all(),
    });
    assert.equal(after, before);
    assert.equal(stored.quote.total_cents, 14700);
    assert.deepEqual(
      stored.lines.map((l) => l.unit_price_cents),
      [10000, -1000],
    );
  } finally {
    db.close();
  }
});

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    }
    seedOperatingCore(this.raw);
  }

  prepare(sql: string) {
    return new SqliteStatement(this.raw, this.raw.prepare(sql));
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}

class SqliteStatement {
  private readonly database: DatabaseSync;
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(
    database: DatabaseSync,
    statement: StatementSync,
    args: unknown[] = [],
  ) {
    this.database = database;
    this.statement = statement;
    this.args = args;
  }

  bind(...args: unknown[]) {
    return new SqliteStatement(this.database, this.statement, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const before = totalChanges(this.database);
    this.statement.run(...this.args);
    return { success: true, meta: { changes: totalChanges(this.database) - before } };
  }
}

test("native commercial authority records a complete autonomous customer contract chain", async () => {
  const db = new SqliteD1();
  const env = commercialEnv(db);
  try {
    const leadInput: RecordLeadTriageInput = {
      tenantId: TENANT,
      leadId: LEAD_ID,
      expectedLeadVersion: 1,
      lifecycleStatus: "qualified",
      priority: "high",
      category: "replacement",
      summary: "Qualified replacement lead with verified address and intake evidence.",
      nextAction: "Prepare a complete roof replacement quote.",
      authority: { kind: "policy_permit", permitId: "pending" },
      idempotencyKey: "commercial:triage:0001",
    };
    const leadPermit = await admitFor(
      env,
      "lead.triage.record",
      { type: "lead", id: LEAD_ID, version: 1 },
      buildLeadTriageCommand(leadInput),
      "permit:triage:0001",
    );
    leadInput.authority = { kind: "policy_permit", permitId: leadPermit.permit_id };
    const triage = await recordLeadTriageDecision(env, leadInput, at(1));
    assert.equal(triage.kind, "created");
    assert.equal(triage.decision.lead_version, 2);
    const lead = db.raw.prepare(
      "SELECT lifecycle_status, version FROM operating_leads WHERE lead_id = ?",
    ).get(LEAD_ID) as { lifecycle_status: string; version: number };
    assert.equal(lead.lifecycle_status, "qualified");
    assert.equal(lead.version, 2);
    assert.equal((await recordLeadTriageDecision(env, leadInput, at(20))).kind, "replayed");
    assert.throws(
      () => db.raw.prepare(
        "UPDATE commercial_lead_triage_decisions SET summary = 'rewritten' WHERE triage_decision_id = ?",
      ).run(triage.decision.triage_decision_id),
      /commercial_triage_decisions_append_only/,
    );

    const quoteInput = quoteRequest();
    const preparedQuote = await prepareCommercialQuote(quoteInput);
    assert.deepEqual(
      [preparedQuote.subtotalCents, preparedQuote.taxCents, preparedQuote.totalCents],
      [14_000, 700, 14_700],
    );
    const quotePermit = await admitFor(
      env,
      "quote.revision.record",
      { type: "customer_quote", id: QUOTE_ID, version: 1 },
      preparedQuote.command,
      "permit:quote:0001",
      preparedQuote.totalCents,
    );
    quoteInput.authority = { kind: "policy_permit", permitId: quotePermit.permit_id };
    const quote = await recordCommercialQuoteRevision(env, quoteInput, at(2));
    assert.equal(quote.kind, "created");
    assert.equal(quote.quote.status, "approved");
    assert.deepEqual(quote.lines.map((line) => line.sequence), [1, 2]);
    assert.equal((await recordCommercialQuoteRevision(env, quoteInput, at(20))).kind, "replayed");

    const proposalInput = proposalRequest();
    const preparedProposal = await prepareCommercialProposal(proposalInput);
    const proposalPermit = await admitFor(
      env,
      "proposal.revision.record",
      { type: "proposal", id: PROPOSAL_PACK_ID, version: 1 },
      preparedProposal.command,
      "permit:proposal:0001",
    );
    proposalInput.authority = { kind: "policy_permit", permitId: proposalPermit.permit_id };
    const proposal = await recordCommercialProposalRevision(env, proposalInput, at(3));
    assert.equal(proposal.kind, "created");
    assert.equal(proposal.proposal.terms_hash, quote.quote.terms_hash);

    const publicationInput = publicationRequest();
    const publicationPermit = await admitFor(
      env,
      "proposal.publish",
      { type: "proposal_publication", id: PROPOSAL_PACK_ID, version: 1 },
      buildCommercialPublicationCommand(publicationInput),
      "permit:publication:0001",
    );
    publicationInput.authority = { kind: "policy_permit", permitId: publicationPermit.permit_id };
    publicationInput.externalEffectId = "effect:commercial-publication:0001";
    await assert.rejects(
      recordCommercialProposalPublication(env, publicationInput, at(4)),
      errorCode("commercial_publication_effect_mismatch"),
    );

    await assert.rejects(
      executePublicationEffect(
        env,
        publicationPermit,
        "effect:commercial-wrong-intent:0001",
        "proposal-revision:commercial:wrong",
        "effect:commercial-wrong-intent:0001",
      ),
      errorCode("effect_proposal_failed"),
    );

    const effect = await executePublicationEffect(
      env,
      publicationPermit,
      publicationInput.externalEffectId,
      PROPOSAL_REVISION_ID,
      "effect:commercial-publication:0001",
    );
    assert.equal(effect.effect.state, "succeeded");
    // The first send succeeded but is not recorded yet, so D1 refuses a second send (0156).
    await assert.rejects(
      executePublicationEffect(
        env,
        publicationPermit,
        "effect:commercial-publication:duplicate",
        PROPOSAL_REVISION_ID,
        "effect:commercial-publication:duplicate",
      ),
      errorCode("effect_proposal_delivery_unconfirmed"),
    );

    const publication = await recordCommercialProposalPublication(env, publicationInput, at(4));
    assert.equal(publication.kind, "created");
    assert.equal(publication.publication.state, "published");
    assert.equal((await recordCommercialProposalPublication(env, publicationInput, at(20))).kind, "replayed");

    seedAcceptedIntent(db.raw, quote.quote.terms_hash, quote.quote.terms_json);
    const acceptance = await bindCommercialCustomerAcceptance(env, {
      tenantId: TENANT,
      acceptanceId: "acceptance_abcdef0123456789",
      quoteRevisionId: QUOTE_REVISION_ID,
      proposalRevisionId: PROPOSAL_REVISION_ID,
    }, at(6));
    assert.equal(acceptance.kind, "created");
    assert.equal(acceptance.binding.receipt_hash, "9".repeat(64));
    const convertedLead = db.raw.prepare(
      "SELECT lifecycle_status FROM operating_leads WHERE lead_id = ?",
    ).get(LEAD_ID) as { lifecycle_status: string };
    assert.equal(convertedLead.lifecycle_status, "converted");
    assert.equal((await recordCommercialQuoteRevision(env, quoteInput, at(20))).kind, "replayed");
    assert.equal((await recordCommercialProposalRevision(env, proposalInput, at(20))).kind, "replayed");
    assert.equal((await bindCommercialCustomerAcceptance(env, {
      tenantId: TENANT,
      acceptanceId: "acceptance_abcdef0123456789",
      quoteRevisionId: QUOTE_REVISION_ID,
      proposalRevisionId: PROPOSAL_REVISION_ID,
    }, at(20))).kind, "replayed");

    assert.equal((await getCurrentCommercialQuote(env, TENANT, QUOTE_ID))?.quote.quote_revision_id, QUOTE_REVISION_ID);
    assert.equal((await getCurrentCommercialProposal(env, TENANT, PROPOSAL_PACK_ID))?.proposal_revision_id, PROPOSAL_REVISION_ID);
    assert.equal((await getCurrentCommercialPublication(env, TENANT, PROPOSAL_PACK_ID))?.state, "published");
    assert.equal((await getCommercialAcceptanceForJob(env, TENANT, JOB_ID))?.acceptance_id, "acceptance_abcdef0123456789");

    for (const table of [
      "commercial_authority_permits",
      "commercial_lead_triage_decisions",
      "commercial_quote_revisions",
      "commercial_quote_lines",
      "commercial_proposal_revisions",
      "commercial_proposal_publication_events",
      "commercial_acceptance_bindings",
    ] as const) {
      assert.throws(
        () => db.raw.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`),
        /commercial_/,
        `${table} refuses INSERT OR REPLACE`,
      );
    }
  } finally {
    db.close();
  }
});

test("commercial policy and immutable chain fail closed", async () => {
  const db = new SqliteD1();
  const env = commercialEnv(db);
  try {
    const leadInput = {
      ...leadRequest(),
      authority: { kind: "policy_permit", permitId: "pending" } as const,
    };
    const command = buildLeadTriageCommand(leadInput);
    const first = await admitFor(
      env,
      "lead.triage.record",
      { type: "lead", id: LEAD_ID, version: 1 },
      command,
      "permit:stable-replay:0001",
    );
    const replayed = await admitFor(
      env,
      "lead.triage.record",
      { type: "lead", id: LEAD_ID, version: 1 },
      command,
      "permit:stable-replay:0001",
      null,
      at(0.5),
    );
    assert.equal(replayed.permit_id, first.permit_id);

    const activePolicy = env.COMMERCIAL_AUTHORITY_POLICY_JSON;
    env.COMMERCIAL_AUTHORITY_POLICY_JSON = JSON.stringify({
      ...JSON.parse(activePolicy),
      status: "revoked",
    });
    leadInput.authority = { kind: "policy_permit", permitId: first.permit_id };
    await assert.rejects(
      recordLeadTriageDecision(env, leadInput, at(1)),
      errorCode("commercial_permit_policy_not_current"),
    );
    env.COMMERCIAL_AUTHORITY_POLICY_JSON = activePolicy;

    await assert.rejects(
      admitFor(
        env,
        "lead.triage.record",
        { type: "lead", id: LEAD_ID, version: 1 },
        { ...command, priority: "urgent" },
        "permit:stable-replay:0001",
        null,
        at(0.75),
      ),
      errorCode("commercial_permit_idempotency_conflict"),
    );
    await assert.rejects(
      admitCommercialPermit({ DB: db as never } as AppEnv, {
        tenantId: TENANT,
        actor: { type: "agent", id: "sales-orchestrator" },
        action: "lead.triage.record",
        aggregate: { type: "lead", id: LEAD_ID, version: 1 },
        command,
        facts: { source: "lead-intake" },
        factsObservedAt: NOW.toISOString(),
        evidence: EVIDENCE,
        idempotencyKey: "permit:missing-policy:0001",
        expiresAt: at(5).toISOString(),
      }, NOW),
      errorCode("commercial_policy_missing"),
    );

    const preparedQuote = await prepareCommercialQuote(quoteRequest());
    await assert.rejects(
      prepareCommercialQuote({
        ...quoteRequest(),
        terms: { deposit_percent: 25, payment_schedule: ["deposit", "completion"] },
      }),
      errorCode("commercial_quote_payment_terms_invalid"),
    );
    await assert.rejects(
      admitFor(
        limitedPolicyEnv(db, 10_000),
        "quote.revision.record",
        { type: "customer_quote", id: QUOTE_ID, version: 1 },
        preparedQuote.command,
        "permit:over-ceiling:0001",
        preparedQuote.totalCents,
      ),
      errorCode("commercial_policy_amount_ceiling_exceeded"),
    );

    leadInput.authority = { kind: "policy_permit", permitId: first.permit_id };
    await recordLeadTriageDecision(env, leadInput, at(1));
    await assert.rejects(
      recordLeadTriageDecision(env, {
        ...leadInput,
        idempotencyKey: "commercial:triage:stale-version",
      }, at(2)),
      errorCode("commercial_triage_version_conflict"),
    );
    await assert.rejects(
      bindCommercialCustomerAcceptance(env, {
        tenantId: TENANT,
        acceptanceId: "acceptance_missing0000001",
        quoteRevisionId: QUOTE_REVISION_ID,
        proposalRevisionId: PROPOSAL_REVISION_ID,
      }, at(3)),
      errorCode("commercial_acceptance_chain_mismatch"),
    );
  } finally {
    db.close();
  }
});

test("commercial publication and acceptance refuse numerically highest forked heads", async () => {
  const db = new SqliteD1();
  const env = commercialEnv(db);
  try {
    const leadInput = leadRequest();
    const leadPermit = await admitFor(
      env,
      "lead.triage.record",
      { type: "lead", id: LEAD_ID, version: 1 },
      buildLeadTriageCommand(leadInput),
      "permit:forked-publication:lead",
    );
    leadInput.authority = { kind: "policy_permit", permitId: leadPermit.permit_id };
    await recordLeadTriageDecision(env, leadInput, at(1));

    const quoteInput = quoteRequest();
    const preparedQuote = await prepareCommercialQuote(quoteInput);
    const quotePermit = await admitFor(
      env,
      "quote.revision.record",
      { type: "customer_quote", id: QUOTE_ID, version: 1 },
      preparedQuote.command,
      "permit:forked-publication:quote",
      preparedQuote.totalCents,
    );
    quoteInput.authority = { kind: "policy_permit", permitId: quotePermit.permit_id };
    await recordCommercialQuoteRevision(env, quoteInput, at(2));

    db.raw.exec("DROP TRIGGER commercial_quote_revision_sequence_guard");
    const quote3 = {
      ...quoteRequest(),
      quoteRevisionId: `${QUOTE_REVISION_ID}:fork-3`,
      revisionNumber: 3,
      supersedesQuoteRevisionId: QUOTE_REVISION_ID,
      correctionReason: "Synthetic high-number fork used to prove fail-closed head selection.",
      idempotencyKey: "commercial:quote:fork-3",
    };
    const preparedQuote3 = await prepareCommercialQuote(quote3);
    const quote3Permit = await admitFor(
      env,
      "quote.revision.record",
      { type: "customer_quote", id: QUOTE_ID, version: 3 },
      preparedQuote3.command,
      "permit:forked-publication:quote-3",
      preparedQuote3.totalCents,
    );
    quote3.authority = { kind: "policy_permit", permitId: quote3Permit.permit_id };
    await recordCommercialQuoteRevision(env, quote3, at(2.25));

    const proposalInput = {
      ...proposalRequest(),
      quoteRevisionId: quote3.quoteRevisionId,
    };
    const preparedProposal = await prepareCommercialProposal(proposalInput);
    const proposalPermit = await admitFor(
      env,
      "proposal.revision.record",
      { type: "proposal", id: PROPOSAL_PACK_ID, version: 1 },
      preparedProposal.command,
      "permit:forked-publication:proposal-1",
    );
    proposalInput.authority = { kind: "policy_permit", permitId: proposalPermit.permit_id };
    await recordCommercialProposalRevision(env, proposalInput, at(3));

    db.raw.exec("DROP TRIGGER commercial_proposal_revision_sequence_guard");
    const proposal3 = {
      ...proposalInput,
      proposalRevisionId: `${PROPOSAL_REVISION_ID}:fork-3`,
      revisionNumber: 3,
      supersedesProposalRevisionId: PROPOSAL_REVISION_ID,
      contentRef: "r2://commercial/proposals/fork-3.pdf",
      idempotencyKey: "commercial:proposal:fork-3",
    };
    const preparedProposal3 = await prepareCommercialProposal(proposal3);
    const proposal3Permit = await admitFor(
      env,
      "proposal.revision.record",
      { type: "proposal", id: PROPOSAL_PACK_ID, version: 3 },
      preparedProposal3.command,
      "permit:forked-publication:proposal-3",
    );
    proposal3.authority = { kind: "policy_permit", permitId: proposal3Permit.permit_id };
    await recordCommercialProposalRevision(env, proposal3, at(3.25));

    const publication1 = {
      ...publicationRequest(),
      proposalRevisionId: proposal3.proposalRevisionId,
      idempotencyKey: "commercial:publication:fork-3",
    };
    const publication1Permit = await admitFor(
      env,
      "proposal.publish",
      { type: "proposal_publication", id: PROPOSAL_PACK_ID, version: 1 },
      buildCommercialPublicationCommand(publication1),
      "permit:forked-publication:publish",
    );
    publication1.authority = { kind: "policy_permit", permitId: publication1Permit.permit_id };
    publication1.externalEffectId = "effect:commercial-publication:fork-3";
    await executePublicationEffect(
      env,
      publication1Permit,
      publication1.externalEffectId,
      proposal3.proposalRevisionId,
      "effect:commercial-publication:fork-3",
    );
    await recordCommercialProposalPublication(env, publication1, at(4));

    const proposal2 = {
      ...proposalInput,
      proposalRevisionId: `${PROPOSAL_REVISION_ID}:fork-2`,
      revisionNumber: 2,
      supersedesProposalRevisionId: PROPOSAL_REVISION_ID,
      contentRef: "r2://commercial/proposals/fork-2.pdf",
      idempotencyKey: "commercial:proposal:fork-2",
    };
    const preparedProposal2 = await prepareCommercialProposal(proposal2);
    const proposal2Permit = await admitFor(
      env,
      "proposal.revision.record",
      { type: "proposal", id: PROPOSAL_PACK_ID, version: 2 },
      preparedProposal2.command,
      "permit:forked-publication:proposal-2",
    );
    proposal2.authority = { kind: "policy_permit", permitId: proposal2Permit.permit_id };
    await recordCommercialProposalRevision(env, proposal2, at(4.25));
    assert.equal(await getCurrentCommercialProposal(env, TENANT, PROPOSAL_PACK_ID), null);

    const quote2 = {
      ...quoteRequest(),
      quoteRevisionId: `${QUOTE_REVISION_ID}:fork-2`,
      revisionNumber: 2,
      supersedesQuoteRevisionId: QUOTE_REVISION_ID,
      correctionReason: "Synthetic low-number fork used to prove fail-closed head selection.",
      idempotencyKey: "commercial:quote:fork-2",
    };
    const preparedQuote2 = await prepareCommercialQuote(quote2);
    const quote2Permit = await admitFor(
      env,
      "quote.revision.record",
      { type: "customer_quote", id: QUOTE_ID, version: 2 },
      preparedQuote2.command,
      "permit:forked-publication:quote-2",
      preparedQuote2.totalCents,
    );
    quote2.authority = { kind: "policy_permit", permitId: quote2Permit.permit_id };
    await recordCommercialQuoteRevision(env, quote2, at(4.5));
    assert.equal(await getCurrentCommercialQuote(env, TENANT, QUOTE_ID), null);

    const withdrawal = {
      ...publicationRequest(),
      proposalRevisionId: proposal3.proposalRevisionId,
      publicationVersion: 2,
      previousState: "published" as const,
      state: "withdrawn" as const,
      idempotencyKey: "commercial:publication:forked-withdrawal",
    };
    const withdrawalPermit = await admitFor(
      env,
      "proposal.withdraw",
      { type: "proposal_publication", id: PROPOSAL_PACK_ID, version: 2 },
      buildCommercialPublicationCommand(withdrawal),
      "permit:forked-publication:withdraw",
    );
    withdrawal.authority = { kind: "policy_permit", permitId: withdrawalPermit.permit_id };
    withdrawal.externalEffectId = "effect:commercial-publication:forked-withdrawal";
    await executePublicationEffect(
      env,
      withdrawalPermit,
      withdrawal.externalEffectId,
      proposal3.proposalRevisionId,
      "effect:commercial-publication:forked-withdrawal",
      { publicationVersion: 2, action: "proposal.withdraw", state: "withdrawn" },
    );
    await assert.rejects(
      recordCommercialProposalPublication(env, withdrawal, at(6)),
      errorCode("commercial_publication_proposal_not_current"),
    );

    seedAcceptedIntent(db.raw, preparedQuote3.termsHash, preparedQuote3.termsJson, 3);
    await assert.rejects(
      bindCommercialCustomerAcceptance(env, {
        tenantId: TENANT,
        acceptanceId: "acceptance_abcdef0123456789",
        quoteRevisionId: quote3.quoteRevisionId,
        proposalRevisionId: proposal3.proposalRevisionId,
      }, at(7)),
      errorCode("commercial_acceptance_chain_mismatch"),
    );
  } finally {
    db.close();
  }
});

function leadRequest(): RecordLeadTriageInput {
  return {
    tenantId: TENANT,
    leadId: LEAD_ID,
    expectedLeadVersion: 1,
    lifecycleStatus: "qualified",
    priority: "high",
    category: "replacement",
    summary: "Qualified replacement lead with verified evidence.",
    nextAction: "Prepare quote.",
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: "commercial:triage:default",
  };
}

function quoteRequest(): RecordCommercialQuoteInput {
  return {
    tenantId: TENANT,
    quoteRevisionId: QUOTE_REVISION_ID,
    customerQuoteId: QUOTE_ID,
    revisionNumber: 1,
    roofJobId: JOB_ID,
    customerId: CUSTOMER_ID,
    status: "approved",
    currency: "CAD",
    validUntil: "2026-09-20",
    terms: TERMS,
    evidence: EVIDENCE,
    lines: [
      {
        lineId: "material:shingles",
        sequence: 1,
        kind: "material",
        description: "Architectural shingles",
        quantityMicros: 1_500_000,
        uom: "square",
        unitPriceCents: 10_000,
        taxCode: "GST",
        taxCents: 750,
      },
      {
        lineId: "discount:loyalty",
        sequence: 2,
        kind: "discount",
        description: "Loyalty discount",
        quantityMicros: 1_000_000,
        uom: "each",
        unitPriceCents: -1_000,
        taxCode: "GST",
        taxCents: -50,
      },
    ],
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: "commercial:quote:0001",
  };
}

function proposalRequest(): RecordCommercialProposalInput {
  return {
    tenantId: TENANT,
    proposalRevisionId: PROPOSAL_REVISION_ID,
    proposalPackId: PROPOSAL_PACK_ID,
    revisionNumber: 1,
    quoteRevisionId: QUOTE_REVISION_ID,
    roofJobId: JOB_ID,
    customerId: CUSTOMER_ID,
    title: "Complete roof replacement proposal",
    summary: "Approved scope, price, schedule assumptions, and warranty.",
    terms: TERMS,
    contentRef: "r2://commercial/proposals/0001.pdf",
    contentHash: "b".repeat(64),
    evidence: EVIDENCE,
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: "commercial:proposal:0001",
  };
}

test("commercial authority, quote and proposal reject unscoped upload receipt references", async () => {
  const ref = `evidence-upload://evu_${"a".repeat(64)}`;
  const evidence = [{ ref, sha256: "a".repeat(64) }];
  await assert.rejects(
    prepareCommercialQuote({ ...quoteRequest(), evidence }),
    errorCode("commercial_evidence_invalid"),
  );
  await assert.rejects(
    prepareCommercialProposal({ ...proposalRequest(), contentRef: ref }),
    errorCode("commercial_proposal_content_ref_invalid"),
  );
  const db = new SqliteD1();
  try {
    await assert.rejects(
      admitCommercialPermit(commercialEnv(db), {
        tenantId: TENANT,
        actor: { type: "agent", id: "sales-orchestrator" },
        action: "lead.triage.record",
        aggregate: { type: "lead", id: LEAD_ID, version: 1 },
        command: buildLeadTriageCommand(leadRequest()),
        facts: { source: "native-operating-core" },
        factsObservedAt: NOW.toISOString(),
        evidence,
        idempotencyKey: "permit:reserved-evidence:0001",
        expiresAt: at(10).toISOString(),
      }, NOW),
      errorCode("commercial_evidence_invalid"),
    );
    assert.equal((db.raw.prepare("SELECT count(*) AS n FROM commercial_authority_permits").get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

function publicationRequest(): RecordCommercialPublicationInput {
  return {
    tenantId: TENANT,
    proposalRevisionId: PROPOSAL_REVISION_ID,
    proposalPackId: PROPOSAL_PACK_ID,
    publicationVersion: 1,
    previousState: "draft",
    state: "published",
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: "commercial:publication:0001",
  };
}

async function admitFor(
  env: AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON?: string },
  action: CommercialAction,
  aggregate: { type: "lead" | "customer_quote" | "proposal" | "proposal_publication"; id: string; version: number },
  command: unknown,
  idempotencyKey: string,
  amountCents: number | null = null,
  now = NOW,
) {
  const result = await admitCommercialPermit(env, {
    tenantId: TENANT,
    actor: { type: "agent", id: "sales-orchestrator" },
    action,
    aggregate,
    amountCents,
    command,
    facts: { source: "native-operating-core", observed_version: aggregate.version },
    factsObservedAt: NOW.toISOString(),
    evidence: EVIDENCE,
    idempotencyKey,
    expiresAt: at(10).toISOString(),
  }, now);
  return result.permit;
}

async function executePublicationEffect(
  env: AppEnv,
  permit: CommercialPermitRecord,
  effectId: string,
  intentId: string,
  idempotencyKey: string,
  options: {
    publicationVersion?: number;
    action?: "proposal.publish" | "proposal.withdraw";
    state?: "published" | "withdrawn";
  } = {},
) {
  const publicationVersion = options.publicationVersion ?? 1;
  const action = options.action ?? "proposal.publish";
  const state = options.state ?? "published";
  return await runExternalEffect(env, {
    effectId,
    tenantId: TENANT,
    actor: { type: "agent", id: "sales-orchestrator" },
    taskId: `commercial:${effectId}`,
    authority: commercialEffectAuthority(permit),
    aggregate: { type: "proposal_publication", id: PROPOSAL_PACK_ID, version: publicationVersion },
    intentId,
    action,
    request: { proposal_revision_id: intentId },
    provider: "customer-portal",
    providerAccountRef: "ironwrap-customer-portal",
    idempotencyKey,
    deadlineAt: at(8).toISOString(),
    preconditions: { quote_status: "approved" },
    evidenceRefs: EVIDENCE.map(({ ref }) => ref),
    expectedReadback: { state },
    retryLimit: 1,
    compensationPlan: { action: "proposal.withdraw" },
    correlationId: `correlation:${effectId}`,
  }, {
    async dispatch() {
      return {
        outcome: "accepted" as const,
        value: { published: true },
        providerExternalId: `portal:${effectId}`,
        providerResponse: { state },
        readback: { status: "match" as const, observed: { state } },
      };
    },
    async replay() {
      return { published: true };
    },
  }, at(3.5));
}

function commercialEnv(db: SqliteD1) {
  return limitedPolicyEnv(db, 1_000_000);
}

function limitedPolicyEnv(db: SqliteD1, maxQuoteTotalCents: number) {
  return {
    DB: db as never,
    EFFECT_RUNTIME_ENABLED: "true",
    COMMERCIAL_AUTHORITY_POLICY_JSON: JSON.stringify({
      schema_version: "ironwrap.commercial-authority-policy.v1",
      policy_id: "commercial-sales-autonomy",
      policy_version: "v1",
      tenant_id: TENANT,
      status: "active",
      valid_from: "2026-08-20T00:00:00.000Z",
      valid_until: "2026-08-21T00:00:00.000Z",
      max_fact_age_seconds: 3_600,
      max_permit_lifetime_seconds: 900,
      allowed_actions: [
        "lead.triage.record",
        "quote.revision.record",
        "proposal.revision.record",
        "proposal.publish",
        "proposal.withdraw",
      ],
      allowed_actor_types: ["agent"],
      max_quote_total_cents: maxQuoteTotalCents,
    }),
  } as AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string };
}

function seedOperatingCore(db: DatabaseSync): void {
  const now = NOW.toISOString();
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, 'owner@example.invalid', 'Owner', 'owner', 'owner', NULL, 1, 'test-seed', ?, ?)`,
  ).run(OWNER_ID, TENANT, now, now);
  // These contracts carry a deposit: the tenant takes deposits (MD-13), since 0155's default is OD-01.
  recordDepositPolicy(db, { tenantId: TENANT, ownerUserId: OWNER_ID, at: now });
  db.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
      status, created_at, updated_at)
     VALUES (?, 'website', 'Customer', 'customer@example.invalid', '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(ENVELOPE_ID, "raw/commercial/0001.json", now, now, now);
  db.prepare(
    `INSERT INTO operating_leads
     (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'website', 'Customer', 'customer@example.invalid', 'untriaged', 1, ?, ?)`,
  ).run(LEAD_ID, TENANT, ENVELOPE_ID, "raw/commercial/0001.json", now, now);
  db.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Customer', 'customer@example.invalid', 'prospect', 1, ?, ?)`,
  ).run(CUSTOMER_ID, TENANT, ENVELOPE_ID, "raw/commercial/0001.json", now, now);
  db.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
      source_raw_key, brand, service_type, job_status, current_gate_state, version,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'ironwrap', 'roof_replacement', 'qualified',
             'qualification', 1, ?, ?)`,
  ).run(JOB_ID, TENANT, LEAD_ID, CUSTOMER_ID, ENVELOPE_ID, "raw/commercial/0001.json", now, now);
}

function seedAcceptedIntent(
  db: DatabaseSync,
  termsHash: string,
  termsJson: string,
  quoteVersion = 1,
): void {
  const acceptedAt = at(5).toISOString();
  db.prepare(
    `INSERT INTO customer_portal_links (
       link_id, token_hash, tenant_id, roof_job_id, customer_id, issued_by_user_id,
       created_at, expires_at, issued_ip_hash, issued_user_agent_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "portal_abcdef0123456789", "1".repeat(64), TENANT, JOB_ID, CUSTOMER_ID, OWNER_ID,
    at(0).toISOString(), at(60).toISOString(), "2".repeat(64), "3".repeat(64),
  );
  db.prepare(
    `INSERT INTO customer_portal_acceptance_challenges (
       challenge_id, token_hash, tenant_id, portal_link_id, roof_job_id, customer_id,
       email_hash, quote_id, quote_version, proposal_pack_id, terms_hash, terms_json,
       request_ip_hash, request_user_agent_hash, state, created_at, expires_at,
       sent_at, provider_message_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?)`,
  ).run(
    "acceptance_challenge_abcdef0123456789", "4".repeat(64), TENANT,
    "portal_abcdef0123456789", JOB_ID, CUSTOMER_ID, "5".repeat(64), QUOTE_ID,
    quoteVersion, PROPOSAL_PACK_ID, termsHash, termsJson, "6".repeat(64), "7".repeat(64),
    at(4.5).toISOString(), at(15).toISOString(), at(4.75).toISOString(), "message:0001",
  );
  db.prepare(
    `INSERT INTO customer_portal_acceptance_intents (
       acceptance_id, idempotency_key_hash, request_fingerprint, challenge_id,
       tenant_id, portal_link_id, roof_job_id, customer_id, email_hash, quote_id,
       quote_version, proposal_pack_id, terms_hash, terms_json, signer_name,
       signer_ip_hash, accepted_at, receipt_key, receipt_hash, receipt_content_length,
       state, frappe_attempted_at, frappe_attempt_lease_expires_at, result_json,
       response_status, error_code, created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Customer', ?, ?, ?, ?, 512,
               'accepted', ?, NULL, '{}', 200, NULL, ?, ?, ?)`,
  ).run(
    "acceptance_abcdef0123456789", "8".repeat(64), "a".repeat(64),
    "acceptance_challenge_abcdef0123456789", TENANT, "portal_abcdef0123456789",
    JOB_ID, CUSTOMER_ID, "5".repeat(64), QUOTE_ID, quoteVersion, PROPOSAL_PACK_ID, termsHash,
    termsJson, "b".repeat(64), acceptedAt,
    `customer-contract-acceptance/v1/${"c".repeat(64)}.json`, "9".repeat(64),
    at(5.25).toISOString(), acceptedAt, at(5.5).toISOString(), at(5.5).toISOString(),
  );
}

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

function totalChanges(database: DatabaseSync): number {
  return Number((database.prepare("SELECT total_changes() AS total").get() as { total: number }).total);
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && (
    error.message === code ||
    (error instanceof CommercialStoreError && error.code === code) ||
    ("code" in error && (error as { code?: unknown }).code === code)
  );
}
