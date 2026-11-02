import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import type { AppEnv } from "../src/app-types.ts";
import {
  admitCommercialPermit,
  commercialEffectAuthority,
  type CommercialAction,
  type CommercialPermitRecord,
} from "../src/commercial-authority.ts";
import {
  bindCommercialCustomerAcceptance,
  buildCommercialPublicationCommand,
  prepareCommercialProposal,
  prepareCommercialQuote,
  recordCommercialProposalPublication,
  recordCommercialProposalRevision,
  recordCommercialQuoteRevision,
  type RecordCommercialProposalInput,
  type RecordCommercialPublicationInput,
  type RecordCommercialQuoteInput,
} from "../src/commercial-store.ts";
import { runExternalEffect } from "../src/effect-runtime.ts";
import { reconcileFacetDesignFrappeProjections } from "../src/facet-design-frappe-projection.ts";
import { reconcileFacetDesignNativeProjections } from "../src/facet-design-projection.ts";
import { canonicalJson } from "../src/facet-design-v2-protocol.ts";
import { issueFacetLaunch } from "../src/facet-launch.ts";
import { listFacetV2WorkflowEvidence } from "../src/facet-v2-evidence.ts";
import { recordDepositPolicy } from "./deposit-policy-fixture.ts";

const TENANT = "ironwrap";
const SOURCE_TENANT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OWNER = "owner-user-0001";
const ENVELOPE = "ow_facet_projection_0001";
const LEAD = "lead:facet-projection:0001";
const CUSTOMER = "CUSTOMER-1";
const CUSTOMER_EMAIL = "customer@example.invalid";
const JOB = "roof-job-1";
const QUOTE = "customer-quote-1";
const EVENT = "44444444-4444-4444-8444-444444444444";
const CORRECTION = "55555555-5555-4555-8555-555555555555";
const TERMINAL = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2027-01-15T08:00:00.000Z");
const HMAC_KEY = Buffer.from(
  "synthetic-facet-projection-key-32bytes",
  "utf8",
).toString("base64url");
const EVIDENCE = [
  { ref: "r2://facet-projection/evidence/0001.json", sha256: "a".repeat(64) },
] as const;
const TERMS = {
  deposit_percent: 25,
  payment_schedule: ["deposit", "completion"],
  payment_terms_days: 30,
  warranty_years: 10,
};
const ROUTE = {
  version: 1,
  issuer: "facet",
  source_product: "facet",
  source_environment: "production",
  source_tenant_id: SOURCE_TENANT,
  destination_tenant_id: TENANT,
  destination_url: "https://bus.example.invalid/ingest/facet-design",
};

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  private launchReadFailures = 0;
  private beforeBatch: (() => void) | null = null;

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

  failNextLaunchRead(): void {
    this.launchReadFailures += 1;
  }

  beforeNextBatch(action: () => void): void {
    assert.equal(this.beforeBatch, null);
    this.beforeBatch = action;
  }

  // The effect runtime claims an attempt through env.DB.batch; a sequential
  // run is equivalent for a synchronous test double.
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql: string): SqliteStatement {
    if (
      this.launchReadFailures > 0 &&
      sql.includes("FROM facet_v2_project_launches")
    ) {
      this.launchReadFailures -= 1;
      throw new Error("synthetic_launch_read_failure");
    }
    return new SqliteStatement(this.raw, this.raw.prepare(sql));
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    const beforeBatch = this.beforeBatch;
    this.beforeBatch = null;
    beforeBatch?.();
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

  close(): void {
    this.raw.close();
  }
}

class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(
    raw: DatabaseSync,
    statement: StatementSync,
    args: unknown[] = [],
  ) {
    this.raw = raw;
    this.statement = statement;
    this.args = args;
  }

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.raw, this.statement, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.execute();
  }

  execute(): { success: true; meta: { changes: number } } {
    const result = this.statement.run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

type NativeEnv = AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string };

function nativeEnv(db: SqliteD1): NativeEnv {
  return {
    DB: db as never,
    EFFECT_RUNTIME_ENABLED: "true",
    FACET_V2_NATIVE_PROJECTION_ENABLED: "true",
    APP_FACET_LAUNCH_ENABLED: "true",
    APP_FACET_LAUNCH_BASE_URL: "https://facet.example.invalid/",
    APP_FACET_LAUNCH_SOURCE_TENANT_ID: SOURCE_TENANT,
    FACET_LAUNCH_HMAC_KEY: HMAC_KEY,
    FACET_V2_ROUTES_JSON: JSON.stringify([ROUTE]),
    COMMERCIAL_AUTHORITY_POLICY_JSON: JSON.stringify({
      schema_version: "ironwrap.commercial-authority-policy.v1",
      policy_id: "facet-projection-commercial-authority",
      policy_version: "v1",
      tenant_id: TENANT,
      status: "active",
      valid_from: "2027-01-15T00:00:00.000Z",
      valid_until: "2027-01-16T00:00:00.000Z",
      max_fact_age_seconds: 3_600,
      max_permit_lifetime_seconds: 900,
      allowed_actions: [
        "quote.revision.record",
        "proposal.revision.record",
        "proposal.publish",
        "proposal.withdraw",
      ],
      allowed_actor_types: ["agent"],
      max_quote_total_cents: 10_000_000,
    }),
  } as NativeEnv;
}

async function fixture(): Promise<{ db: SqliteD1; env: NativeEnv }> {
  const db = new SqliteD1();
  const env = nativeEnv(db);
  await seedNativeAcceptedContract(db, env, 1);
  const launch = await issueFacetLaunch(env, {
    tenantId: TENANT,
    jobName: JOB,
    actorUserId: OWNER,
    actorRole: "owner",
    idempotencyKey: "facet-projection:launch:0001",
    now: NOW,
    projectId: PROJECT,
  });
  assert.equal(launch.kind, "created", JSON.stringify(launch));
  return { db, env };
}

function seedDecision(
  db: SqliteD1,
  input: {
    eventId?: string;
    decision?: "approved" | "corrected" | "superseded" | "withdrawn";
    previousEventId?: string | null;
    occurredAt?: string;
    receivedAt?: string;
    projectId?: string;
  } = {},
): string {
  const projectId = input.projectId ?? PROJECT;
  const link = db.raw
    .prepare(
      `SELECT external_project_link_id, producer_identity_link_id,
              destination_tenant_id, source_tenant_id, brand_id,
              facet_project_id, customer_party_ref,
              external_customer_identity_link_id, roof_job_id,
              customer_quote_id, association_sha256
         FROM facet_v2_project_links
        WHERE destination_tenant_id = ? AND facet_project_id = ?`,
    )
    .get(TENANT, projectId) as Record<string, string>;
  const eventId = input.eventId ?? EVENT;
  const decision = input.decision ?? "approved";
  const previousEventId = input.previousEventId ?? null;
  const eventBodySha256 = sha256(eventId);
  const designRevisionSha256 = sha256(`design:${eventId}`);
  const occurredAt = input.occurredAt ?? "2027-01-15T08:10:00.000Z";
  const receivedAt = input.receivedAt ?? new Date(Date.parse(occurredAt) + 1_000).toISOString();
  db.raw
    .prepare(
      `INSERT INTO facet_v2_customer_decisions
       (event_id, event_type, schema_version, event_body_sha256, issuer,
        source_product, source_environment, source_tenant_id,
        destination_tenant_id, brand_id, facet_project_id,
        external_project_link_id, producer_identity_link_id,
        association_sha256, roof_job_id, customer_quote_id,
        customer_party_ref, external_customer_identity_link_id, oidc_issuer,
        oidc_subject_sha256, identity_assurance, attestation_version,
        decision_kind, previous_event_id, reason_sha256, approval_receipt_id,
        approval_receipt_sha256, design_revision_id, design_revision_sha256,
        frozen_evidence_sha256, raw_key, raw_sha256, raw_content_length,
        occurred_at, received_at)
       VALUES (?, 'facet.design.customer_approved.v2', 2, ?, 'facet', 'facet',
               'production', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               'https://accounts.google.com', ?, 'oidc',
               'facet-customer-approval-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               512, ?, ?)`,
    )
    .run(
      eventId,
      eventBodySha256,
      link.source_tenant_id,
      link.destination_tenant_id,
      link.brand_id,
      link.facet_project_id,
      link.external_project_link_id,
      link.producer_identity_link_id,
      link.association_sha256,
      link.roof_job_id,
      link.customer_quote_id,
      link.customer_party_ref,
      link.external_customer_identity_link_id,
      sha256("oidc-subject"),
      decision,
      previousEventId,
      decision === "approved" ? null : sha256(`reason:${eventId}`),
      eventId,
      sha256(`approval:${eventId}`),
      `facet-json-v1:${designRevisionSha256}`,
      designRevisionSha256,
      sha256(`frozen:${eventId}`),
      `facet-design/v2/raw/${eventBodySha256}.json`,
      eventBodySha256,
      occurredAt,
      receivedAt,
    );
  return eventId;
}

function seedDecisionChain(db: SqliteD1, length: number): string[] {
  const eventIds: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const eventId = `90000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`;
    seedDecision(db, {
      eventId,
      decision: index === 0 ? "approved" : "corrected",
      previousEventId: eventIds.at(-1) ?? null,
      occurredAt: new Date(Date.parse("2027-01-15T08:10:00.000Z") + index * 1_000).toISOString(),
    });
    eventIds.push(eventId);
  }
  return eventIds;
}

function seedIndependentProjectedHead(
  db: SqliteD1,
  ordinal: number,
  input: {
    decision?: "approved" | "corrected";
    previousEventId?: string | null;
    occurredAt?: string;
    receivedAt?: string;
    projectionTemplateEventId?: string;
  } = {},
): string {
  const suffix = ordinal.toString(16).padStart(12, "0");
  const projectId = `70000000-0000-4000-8000-${suffix}`;
  const eventId = `80000000-0000-4000-8000-${suffix}`;
  const externalProjectLinkId = `ironwrap-project-v1:${sha256(`project:${projectId}`)}`;
  const base = db.raw.prepare(
    `SELECT producer_identity_link_id, destination_tenant_id, source_tenant_id,
            brand_id, customer_party_ref, external_customer_identity_link_id,
            roof_job_id, customer_quote_id, created_by_user_id, created_at
       FROM facet_v2_project_links
      WHERE destination_tenant_id = ? AND facet_project_id = ?`,
  ).get(TENANT, PROJECT) as Record<string, string>;
  const associationSha256 = sha256(canonicalJson({
    brand_id: base.brand_id,
    customer_party_ref: base.customer_party_ref,
    customer_quote_id: base.customer_quote_id,
    destination_tenant_id: base.destination_tenant_id,
    external_customer_identity_link_id: base.external_customer_identity_link_id,
    external_project_link_id: externalProjectLinkId,
    facet_project_id: projectId,
    producer_identity_link_id: base.producer_identity_link_id,
    roof_job_id: base.roof_job_id,
    source_tenant_id: base.source_tenant_id,
  }));
  db.raw.prepare(
    `INSERT INTO facet_v2_project_links
     (external_project_link_id, producer_identity_link_id,
      destination_tenant_id, source_tenant_id, brand_id, facet_project_id,
      customer_party_ref, external_customer_identity_link_id, roof_job_id,
      customer_quote_id, project_claim_sha256, association_sha256,
      created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    externalProjectLinkId,
    base.producer_identity_link_id,
    base.destination_tenant_id,
    base.source_tenant_id,
    base.brand_id,
    projectId,
    base.customer_party_ref,
    base.external_customer_identity_link_id,
    base.roof_job_id,
    base.customer_quote_id,
    sha256(`claim:${projectId}`),
    associationSha256,
    base.created_by_user_id,
    base.created_at,
  );
  db.raw.prepare(
    `INSERT INTO facet_v2_project_launches
     (facet_project_id, external_project_link_id, destination_tenant_id,
      source_tenant_id, brand_id, roof_job_id, customer_quote_id,
      quote_version, quote_approved_at, customer_party_ref,
      external_customer_identity_link_id, issued_by_user_id,
      idempotency_key_sha256, launch_intent_sha256,
      launch_envelope_sha256, issued_at, not_before, expires_at, created_at)
     SELECT ?, ?, destination_tenant_id, source_tenant_id, brand_id,
            roof_job_id, customer_quote_id, quote_version, quote_approved_at,
            customer_party_ref, external_customer_identity_link_id,
            issued_by_user_id, ?, launch_intent_sha256, ?, issued_at,
            not_before, expires_at, created_at
       FROM facet_v2_project_launches
      WHERE facet_project_id = ?`,
  ).run(
    projectId,
    externalProjectLinkId,
    sha256(`launch-idempotency:${projectId}`),
    sha256(`launch-envelope:${projectId}`),
    PROJECT,
  );
  seedDecision(db, {
    eventId,
    decision: input.decision,
    previousEventId: input.previousEventId,
    occurredAt: input.occurredAt ?? new Date(Date.parse("2027-01-15T08:20:00.000Z") + ordinal * 1_000).toISOString(),
    receivedAt: input.receivedAt,
    projectId,
  });
  const decision = db.raw.prepare(
    `SELECT decision_kind, previous_event_id, design_revision_id,
            design_revision_sha256, frozen_evidence_sha256, raw_sha256
       FROM facet_v2_customer_decisions WHERE event_id = ?`,
  ).get(eventId) as Record<string, string | null>;
  db.raw.prepare(
    `INSERT INTO facet_v2_native_design_projections
     (projection_id, event_id, destination_tenant_id, source_tenant_id,
      brand_id, facet_project_id, external_project_link_id,
      producer_identity_link_id, external_customer_identity_link_id,
      roof_job_id, customer_id, customer_quote_id, source_quote_revision_id,
      source_quote_version, source_quote_approved_at,
      source_proposal_revision_id, source_proposal_pack_id,
      source_publication_event_id, source_acceptance_binding_id,
      source_acceptance_id, source_acceptance_accepted_at,
      source_acceptance_receipt_hash, launch_intent_sha256, decision_kind,
      design_sequence, design_state, previous_event_id, design_revision_id,
      design_revision_sha256, frozen_evidence_sha256, raw_sha256,
      projection_sha256, projected_at)
     SELECT ?, ?, destination_tenant_id, source_tenant_id, brand_id, ?, ?,
            producer_identity_link_id, external_customer_identity_link_id,
            roof_job_id, customer_id, customer_quote_id,
            source_quote_revision_id, source_quote_version,
            source_quote_approved_at, source_proposal_revision_id,
            source_proposal_pack_id, source_publication_event_id,
            source_acceptance_binding_id, source_acceptance_id,
            source_acceptance_accepted_at, source_acceptance_receipt_hash,
            launch_intent_sha256, ?, ?, ?, ?, ?, ?, ?, ?, ?, projected_at
       FROM facet_v2_native_design_projections
      WHERE event_id = ?`,
  ).run(
    `facet-native-design-v2:${sha256(eventId)}`,
    eventId,
    projectId,
    externalProjectLinkId,
    decision.decision_kind,
    decision.decision_kind === "approved" ? 1 : 2,
    "active",
    decision.previous_event_id,
    decision.design_revision_id,
    decision.design_revision_sha256,
    decision.frozen_evidence_sha256,
    decision.raw_sha256,
    sha256(`projection:${eventId}`),
    input.projectionTemplateEventId ?? EVENT,
  );
  return eventId;
}

function installNetworkTrap(): {
  count(): number;
  restore(): void;
} {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("facet_projection_network_forbidden");
  };
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function attempts(
  db: SqliteD1,
  eventId = EVENT,
): Array<{
  outcome: string;
  projection_id: string | null;
  projection_sha256: string | null;
  error_code: string | null;
}> {
  return db.raw
    .prepare(
      `SELECT outcome, projection_id, projection_sha256, error_code
         FROM facet_v2_native_projection_attempts
        WHERE event_id = ?
        ORDER BY attempted_at, attempt_id`,
    )
    .all(eventId)
    .map((row) => ({ ...row })) as ReturnType<typeof attempts>;
}

function projection(
  db: SqliteD1,
  eventId = EVENT,
): Record<string, unknown> | null {
  const row = db.raw
    .prepare(
      `SELECT projection_id, event_id, destination_tenant_id, source_tenant_id,
              brand_id, facet_project_id, external_project_link_id,
              external_customer_identity_link_id, roof_job_id, customer_id,
              customer_quote_id, source_quote_revision_id, source_quote_version,
              source_quote_approved_at, source_proposal_revision_id,
              source_proposal_pack_id, source_publication_event_id,
              source_acceptance_binding_id, source_acceptance_id,
              source_acceptance_accepted_at, source_acceptance_receipt_hash,
              decision_kind, design_sequence, design_state, previous_event_id,
              design_revision_id, design_revision_sha256,
              frozen_evidence_sha256, raw_sha256, projection_sha256
         FROM facet_v2_native_design_projections
        WHERE event_id = ?`,
    )
    .get(eventId);
  return row ? { ...row } : null;
}

test("native projection records an exact idempotent design authority without Frappe or network", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  const network = installNetworkTrap();
  try {
    await reconcileFacetDesignNativeProjections(
      env,
      new Date("2027-01-15T08:11:00.000Z"),
    );
    await reconcileFacetDesignNativeProjections(
      env,
      new Date("2027-01-15T08:12:00.000Z"),
    );
    assert.equal(network.count(), 0);
  } finally {
    network.restore();
  }

  const eventHash = sha256(EVENT);
  const projectionId = `facet-native-design-v2:${eventHash}`;
  const persisted = projection(db);
  assert.ok(persisted);
  const sourceAuthority = db.raw
    .prepare(
      `SELECT publication.publication_event_id,
              acceptance.acceptance_binding_id
         FROM commercial_proposal_publication_events publication
         JOIN commercial_acceptance_bindings acceptance
           ON acceptance.tenant_id = publication.tenant_id
          AND acceptance.proposal_revision_id = publication.proposal_revision_id
        WHERE publication.tenant_id = ? AND publication.state = 'published'`,
    )
    .get(TENANT) as {
    publication_event_id: string;
    acceptance_binding_id: string;
  };
  assert.deepEqual(
    {
      ...persisted,
      projection_sha256: "<sha256>",
      external_project_link_id: "<project-link>",
      external_customer_identity_link_id: "<customer-link>",
    },
    {
      projection_id: projectionId,
      event_id: EVENT,
      destination_tenant_id: TENANT,
      source_tenant_id: SOURCE_TENANT,
      brand_id: TENANT,
      facet_project_id: PROJECT,
      external_project_link_id: "<project-link>",
      external_customer_identity_link_id: "<customer-link>",
      roof_job_id: JOB,
      customer_id: CUSTOMER,
      customer_quote_id: QUOTE,
      source_quote_revision_id: quoteRevision(1),
      source_quote_version: 1,
      source_quote_approved_at: quoteTime(1).toISOString(),
      source_proposal_revision_id: proposalRevision(1),
      source_proposal_pack_id: proposalPack(1),
      source_publication_event_id: sourceAuthority.publication_event_id,
      source_acceptance_binding_id: sourceAuthority.acceptance_binding_id,
      source_acceptance_id: acceptanceId(1),
      source_acceptance_accepted_at: chainTime(1, 30).toISOString(),
      source_acceptance_receipt_hash: sha256("receipt-body-1"),
      decision_kind: "approved",
      design_sequence: 1,
      design_state: "active",
      previous_event_id: null,
      design_revision_id: `facet-json-v1:${sha256(`design:${EVENT}`)}`,
      design_revision_sha256: sha256(`design:${EVENT}`),
      frozen_evidence_sha256: sha256(`frozen:${EVENT}`),
      raw_sha256: sha256(EVENT),
      projection_sha256: "<sha256>",
    },
  );
  assert.match(String(persisted.projection_sha256), /^[0-9a-f]{64}$/);
  assert.deepEqual(attempts(db), [
    {
      outcome: "projected_native_design",
      projection_id: projectionId,
      projection_sha256: persisted.projection_sha256,
      error_code: null,
    },
  ]);
  assert.equal(
    Number(
      (
        db.raw
          .prepare(
            `SELECT COUNT(*) AS count FROM external_effects
              WHERE action = 'facet.design.v2.projection' OR provider = 'frappe'`,
          )
          .get() as { count: number }
      ).count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        db.raw
          .prepare(`SELECT COUNT(*) AS count FROM commercial_quote_revisions`)
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        db.raw
          .prepare(`SELECT COUNT(*) AS count FROM facet_v2_projection_attempts`)
          .get() as { count: number }
      ).count,
    ),
    0,
  );
  assert.throws(
    () =>
      db.raw
        .prepare(
          `UPDATE facet_v2_native_design_projections
              SET design_state = 'withdrawn' WHERE event_id = ?`,
        )
        .run(EVENT),
    /append_only/,
  );
  assert.throws(
    () =>
      db.raw
        .prepare(
          `DELETE FROM facet_v2_native_projection_attempts WHERE event_id = ?`,
        )
        .run(EVENT),
    /append_only/,
  );
  const workflow = await listFacetV2WorkflowEvidence(env, TENANT);
  assert.equal(workflow[0]?.projection_state, "projected");
  assert.equal(workflow[0]?.status_code, "native_design_projected");
  assert.equal(workflow[0]?.projection?.projection_id, projectionId);
  assert.equal(
    workflow[0]?.projection?.source_quote_revision_id,
    quoteRevision(1),
  );
  db.close();
});

test("correction projects only the signed chain head at a monotonic native version", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  seedDecision(db, {
    eventId: CORRECTION,
    decision: "corrected",
    previousEventId: EVENT,
    occurredAt: "2027-01-15T08:12:00.000Z",
  });
  const network = installNetworkTrap();
  try {
    await reconcileFacetDesignNativeProjections(env);
    assert.equal(network.count(), 0);
  } finally {
    network.restore();
  }
  assert.deepEqual(attempts(db, EVENT), []);
  assert.equal(attempts(db, CORRECTION)[0]?.outcome, "projected_native_design");
  assert.deepEqual(
    {
      source_quote_revision_id: projection(db, CORRECTION)
        ?.source_quote_revision_id,
      source_quote_version: projection(db, CORRECTION)?.source_quote_version,
      design_sequence: projection(db, CORRECTION)?.design_sequence,
      design_state: projection(db, CORRECTION)?.design_state,
      previous_event_id: projection(db, CORRECTION)?.previous_event_id,
    },
    {
      source_quote_revision_id: quoteRevision(1),
      source_quote_version: 1,
      design_sequence: 2,
      design_state: "active",
      previous_event_id: EVENT,
    },
  );
  db.close();
});

for (const decision of ["withdrawn", "superseded"] as const) {
  test(`${decision} remains an explicit native terminal hold`, async () => {
    const { db, env } = await fixture();
    seedDecision(db);
    seedDecision(db, {
      eventId: TERMINAL,
      decision,
      previousEventId: EVENT,
      occurredAt: "2027-01-15T08:12:00.000Z",
    });
    const network = installNetworkTrap();
    try {
      await reconcileFacetDesignNativeProjections(env);
      assert.equal(network.count(), 0);
    } finally {
      network.restore();
    }
    assert.equal(
      attempts(db, TERMINAL)[0]?.outcome,
      decision === "withdrawn" ? "held_withdrawn" : "held_superseded",
    );
    assert.equal(projection(db, TERMINAL)?.design_state, decision);
    assert.equal(projection(db, TERMINAL)?.design_sequence, 2);
    assert.equal(projection(db, TERMINAL)?.source_quote_version, 1);
    const workflow = await listFacetV2WorkflowEvidence(env, TENANT);
    assert.equal(workflow[0]?.projection_state, "held");
    assert.equal(
      workflow[0]?.status_code,
      decision === "withdrawn"
        ? "customer_withdrew_design"
        : "customer_superseded_design",
    );
    db.close();
  });
}

test("revoked identity and changed native commercial authority fail closed", async () => {
  const revoked = await fixture();
  seedDecision(revoked.db);
  const projectLink = (
    revoked.db.raw
      .prepare(
        `SELECT external_project_link_id FROM facet_v2_project_links
          WHERE facet_project_id = ?`,
      )
      .get(PROJECT) as { external_project_link_id: string }
  ).external_project_link_id;
  revoked.db.raw
    .prepare(
      `INSERT INTO facet_v2_link_revocations
       (revocation_id, link_kind, link_id, reason_code, revoked_by_user_id,
        destination_tenant_id, revoked_at)
       VALUES ('facet-projection-revocation-0001', 'project', ?,
               'customer_request', ?, ?, '2027-01-15T08:10:30.000Z')`,
    )
    .run(projectLink, OWNER, TENANT);
  await reconcileFacetDesignNativeProjections(revoked.env);
  assert.deepEqual(attempts(revoked.db), [
    {
      outcome: "rejected",
      projection_id: null,
      projection_sha256: null,
      error_code: "facet_v2_authority_drift",
    },
  ]);
  revoked.db.close();

  const drifted = await fixture();
  seedDecision(drifted.db);
  await seedNativeAcceptedContract(drifted.db, drifted.env, 2);
  await reconcileFacetDesignNativeProjections(drifted.env);
  assert.deepEqual(attempts(drifted.db), [
    {
      outcome: "rejected",
      projection_id: null,
      projection_sha256: null,
      error_code: "facet_v2_native_commercial_authority_drift",
    },
  ]);
  drifted.db.close();
});

test("a revocation racing the projection transaction is rejected without a native design", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  const projectLink = (
    db.raw
      .prepare(
        `SELECT external_project_link_id FROM facet_v2_project_links
          WHERE facet_project_id = ?`,
      )
      .get(PROJECT) as { external_project_link_id: string }
  ).external_project_link_id;
  db.beforeNextBatch(() => {
    db.raw
      .prepare(
        `INSERT INTO facet_v2_link_revocations
         (revocation_id, link_kind, link_id, reason_code, revoked_by_user_id,
          destination_tenant_id, revoked_at)
         VALUES ('facet-projection-race-revocation-0001', 'project', ?,
                 'customer_request', ?, ?, '2027-01-15T08:10:30.000Z')`,
      )
      .run(projectLink, OWNER, TENANT);
  });

  await reconcileFacetDesignNativeProjections(
    env,
    new Date("2027-01-15T08:11:00.000Z"),
  );

  assert.equal(projection(db), null);
  assert.deepEqual(attempts(db), [
    {
      outcome: "rejected",
      projection_id: null,
      projection_sha256: null,
      error_code: "facet_v2_authority_drift",
    },
  ]);
  db.close();
});

test("a correction racing the projection transaction becomes the only native design head", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  db.beforeNextBatch(() => {
    seedDecision(db, {
      eventId: CORRECTION,
      decision: "corrected",
      previousEventId: EVENT,
      occurredAt: "2027-01-15T08:10:30.000Z",
    });
  });

  await reconcileFacetDesignNativeProjections(
    env,
    new Date("2027-01-15T08:11:00.000Z"),
  );
  await reconcileFacetDesignNativeProjections(
    env,
    new Date("2027-01-15T08:12:00.000Z"),
  );

  assert.equal(projection(db, EVENT), null);
  assert.deepEqual(attempts(db, EVENT), [
    {
      outcome: "rejected",
      projection_id: null,
      projection_sha256: null,
      error_code: "facet_v2_native_decision_not_current",
    },
  ]);
  assert.equal(projection(db, CORRECTION)?.design_state, "active");
  assert.equal(projection(db, CORRECTION)?.design_sequence, 2);
  assert.equal(attempts(db, CORRECTION)[0]?.outcome, "projected_native_design");
  db.close();
});

test("an unqualified competing acceptance attempt stays uncertain without fabricating drift", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  const commercial = db.raw
    .prepare(
      `SELECT quote.terms_hash, proposal.terms_json, proposal.proposal_pack_id
         FROM commercial_quote_revisions quote
         JOIN commercial_proposal_revisions proposal
           ON proposal.tenant_id = quote.tenant_id
          AND proposal.quote_revision_id = quote.quote_revision_id
        WHERE quote.quote_revision_id = ? AND proposal.proposal_revision_id = ?`,
    )
    .get(quoteRevision(1), proposalRevision(1)) as {
    terms_hash: string;
    terms_json: string;
    proposal_pack_id: string;
  };
  const competingAcceptedAt = new Date("2027-01-15T08:10:20.000Z");
  seedAcceptedIntent(
    db.raw,
    1,
    commercial.terms_hash,
    commercial.terms_json,
    commercial.proposal_pack_id,
    competingAcceptedAt,
    2,
  );
  db.beforeNextBatch(() => {
    db.raw
      .prepare(
        `INSERT INTO commercial_acceptance_bindings
         (acceptance_binding_id, acceptance_id, tenant_id, quote_revision_id,
          proposal_revision_id, roof_job_id, customer_id, terms_hash,
          receipt_hash, accepted_at, bound_at)
         VALUES ('facet-acceptance-race-binding-0002', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        acceptanceId(2),
        TENANT,
        quoteRevision(1),
        proposalRevision(1),
        JOB,
        CUSTOMER,
        commercial.terms_hash,
        sha256("receipt-body-2"),
        competingAcceptedAt.toISOString(),
        new Date(competingAcceptedAt.getTime() + 30_000).toISOString(),
      );
  });

  await reconcileFacetDesignNativeProjections(
    env,
    new Date("2027-01-15T08:11:00.000Z"),
  );

  assert.equal(projection(db), null);
  assert.equal(
    Number(
      (
        db.raw
          .prepare(
            `SELECT COUNT(*) AS count FROM commercial_acceptance_bindings
              WHERE tenant_id = ? AND roof_job_id = ?`,
          )
          .get(TENANT, JOB) as { count: number }
      ).count,
    ),
    1,
  );
  assert.deepEqual(attempts(db), [
    {
      outcome: "uncertain",
      projection_id: null,
      projection_sha256: null,
      error_code: "facet_v2_native_projection_uncertain",
    },
  ]);
  db.close();
});

test("an uncertain native read retries to one reconciled projection", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  db.failNextLaunchRead();
  const network = installNetworkTrap();
  try {
    await reconcileFacetDesignNativeProjections(
      env,
      new Date("2027-01-15T08:11:00.000Z"),
    );
    await reconcileFacetDesignNativeProjections(
      env,
      new Date("2027-01-15T08:12:00.000Z"),
    );
    await reconcileFacetDesignNativeProjections(
      env,
      new Date("2027-01-15T08:13:00.000Z"),
    );
    assert.equal(network.count(), 0);
  } finally {
    network.restore();
  }
  assert.deepEqual(
    attempts(db).map(({ outcome, error_code }) => ({ outcome, error_code })),
    [
      {
        outcome: "uncertain",
        error_code: "facet_v2_native_authority_read_uncertain",
      },
      { outcome: "reconciled_native_design", error_code: null },
    ],
  );
  assert.equal(
    Number(
      (
        db.raw
          .prepare(
            `SELECT COUNT(*) AS count FROM facet_v2_customer_decisions
              WHERE event_id = ?`,
          )
          .get(EVENT) as { count: number }
      ).count,
    ),
    1,
  );
  db.close();
});

test("an identical uncertain native read is recorded once until a final result exists", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  const network = installNetworkTrap();
  try {
    db.failNextLaunchRead();
    db.failNextLaunchRead();
    db.failNextLaunchRead();
    await Promise.all([
      reconcileFacetDesignNativeProjections(
        env,
        new Date("2027-01-15T08:11:00.000Z"),
      ),
      reconcileFacetDesignNativeProjections(
        env,
        new Date("2027-01-15T08:12:00.000Z"),
      ),
      reconcileFacetDesignNativeProjections(
        env,
        new Date("2027-01-15T08:13:00.000Z"),
      ),
    ]);
    assert.equal(network.count(), 0);
  } finally {
    network.restore();
  }
  assert.deepEqual(
    attempts(db).map(({ outcome, error_code }) => ({ outcome, error_code })),
    [
      {
        outcome: "uncertain",
        error_code: "facet_v2_native_authority_read_uncertain",
      },
    ],
  );
  db.close();
});

test("legacy/manual flags and unassociated intake state cannot project", async () => {
  const { db, env } = await fixture();
  env.FACET_V2_NATIVE_PROJECTION_ENABLED = "false";
  env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  const network = installNetworkTrap();
  try {
    await reconcileFacetDesignNativeProjections(env);
    assert.equal(network.count(), 0);
  } finally {
    network.restore();
  }
  assert.equal(
    Number(
      (
        db.raw
          .prepare(
            `SELECT COUNT(*) AS count FROM facet_v2_native_projection_attempts`,
          )
          .get() as { count: number }
      ).count,
    ),
    0,
  );
  db.close();
});

async function seedNativeAcceptedContract(
  db: SqliteD1,
  env: NativeEnv,
  revisionNumber: number,
): Promise<void> {
  const current = db.raw
    .prepare(
      `SELECT COALESCE(MAX(revision_number), 0) AS revision_number
         FROM commercial_quote_revisions
        WHERE tenant_id = ? AND customer_quote_id = ?`,
    )
    .get(TENANT, QUOTE) as { revision_number: number };
  for (
    let revision = Number(current.revision_number) + 1;
    revision <= revisionNumber;
    revision += 1
  ) {
    const input = quoteRequest(revision);
    const prepared = await prepareCommercialQuote(input);
    const at = quoteTime(revision);
    const permit = await admitFor(
      env,
      "quote.revision.record",
      { type: "customer_quote", id: QUOTE, version: revision },
      prepared.command,
      `permit:facet-projection:quote:${revision}`,
      prepared.totalCents,
      at,
    );
    input.authority = { kind: "policy_permit", permitId: permit.permit_id };
    await recordCommercialQuoteRevision(env, input, at);
  }

  const quoteRevisionId = quoteRevision(revisionNumber);
  const proposalInput = proposalRequest(revisionNumber, quoteRevisionId);
  const preparedProposal = await prepareCommercialProposal(proposalInput);
  const proposalAt = chainTime(revisionNumber, 10);
  const proposalPermit = await admitFor(
    env,
    "proposal.revision.record",
    {
      type: "proposal",
      id: proposalInput.proposalPackId,
      version: proposalInput.revisionNumber,
    },
    preparedProposal.command,
    `permit:facet-projection:proposal:${revisionNumber}`,
    null,
    proposalAt,
  );
  proposalInput.authority = {
    kind: "policy_permit",
    permitId: proposalPermit.permit_id,
  };
  const proposal = await recordCommercialProposalRevision(
    env,
    proposalInput,
    proposalAt,
  );

  const publicationInput = publicationRequest(
    revisionNumber,
    proposal.proposal.proposal_revision_id,
    proposal.proposal.proposal_pack_id,
  );
  const publicationPermit = await admitFor(
    env,
    "proposal.publish",
    {
      type: "proposal_publication",
      id: publicationInput.proposalPackId,
      version: 1,
    },
    buildCommercialPublicationCommand(publicationInput),
    `permit:facet-projection:publication:${revisionNumber}`,
    null,
    chainTime(revisionNumber, 18),
  );
  publicationInput.authority = {
    kind: "policy_permit",
    permitId: publicationPermit.permit_id,
  };
  publicationInput.externalEffectId = `effect:facet-projection-publication:${revisionNumber}`;
  await executePublicationEffect(
    env,
    publicationPermit,
    publicationInput,
    chainTime(revisionNumber, 19),
  );
  await recordCommercialProposalPublication(
    env,
    publicationInput,
    chainTime(revisionNumber, 20),
  );

  const acceptedAt = chainTime(revisionNumber, 30);
  seedAcceptedIntent(
    db.raw,
    revisionNumber,
    proposal.proposal.terms_hash,
    proposal.proposal.terms_json,
    proposal.proposal.proposal_pack_id,
    acceptedAt,
  );
  await bindCommercialCustomerAcceptance(
    env,
    {
      tenantId: TENANT,
      acceptanceId: acceptanceId(revisionNumber),
      quoteRevisionId,
      proposalRevisionId: proposal.proposal.proposal_revision_id,
    },
    chainTime(revisionNumber, 40),
  );
}

function quoteRequest(revisionNumber: number): RecordCommercialQuoteInput {
  return {
    tenantId: TENANT,
    quoteRevisionId: quoteRevision(revisionNumber),
    customerQuoteId: QUOTE,
    revisionNumber,
    roofJobId: JOB,
    customerId: CUSTOMER,
    supersedesQuoteRevisionId:
      revisionNumber === 1 ? undefined : quoteRevision(revisionNumber - 1),
    correctionReason:
      revisionNumber === 1
        ? undefined
        : `Approved commercial correction ${revisionNumber}.`,
    status: "approved",
    currency: "CAD",
    validUntil: "2027-12-31",
    terms: TERMS,
    evidence: EVIDENCE,
    lines: [
      {
        lineId: "roof:replacement",
        sequence: 1,
        kind: "material",
        description: "Approved roof replacement system",
        quantityMicros: 1_000_000,
        uom: "job",
        unitPriceCents: 125_000 + revisionNumber,
        taxCode: "GST",
        taxCents: 6_250,
      },
    ],
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: `facet-projection:quote:${revisionNumber}`,
  };
}

function proposalRequest(
  revisionNumber: number,
  quoteRevisionId: string,
): RecordCommercialProposalInput {
  return {
    tenantId: TENANT,
    proposalRevisionId: proposalRevision(revisionNumber),
    proposalPackId: proposalPack(revisionNumber),
    revisionNumber: 1,
    quoteRevisionId,
    roofJobId: JOB,
    customerId: CUSTOMER,
    title: "Approved roof replacement proposal",
    summary: "Exact current scope, price, payment terms, and warranty.",
    terms: TERMS,
    contentRef: `r2://facet-projection/proposal-${revisionNumber}.pdf`,
    contentHash: sha256(`proposal-content-${revisionNumber}`),
    evidence: EVIDENCE,
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: `facet-projection:proposal:${revisionNumber}`,
  };
}

function publicationRequest(
  revisionNumber: number,
  proposalRevisionId: string,
  proposalPackId: string,
): RecordCommercialPublicationInput {
  return {
    tenantId: TENANT,
    proposalRevisionId,
    proposalPackId,
    publicationVersion: 1,
    previousState: "draft",
    state: "published",
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: `facet-projection:publication:${revisionNumber}`,
  };
}

async function admitFor(
  env: NativeEnv,
  action: CommercialAction,
  aggregate: {
    type: "customer_quote" | "proposal" | "proposal_publication";
    id: string;
    version: number;
  },
  command: unknown,
  idempotencyKey: string,
  amountCents: number | null,
  now: Date,
): Promise<CommercialPermitRecord> {
  const admitted = await admitCommercialPermit(
    env,
    {
      tenantId: TENANT,
      actor: { type: "agent", id: "facet-projection-test-orchestrator" },
      action,
      aggregate,
      amountCents,
      command,
      facts: { source: "native-operating-core", version: aggregate.version },
      factsObservedAt: new Date(now.getTime() - 1_000).toISOString(),
      evidence: EVIDENCE,
      idempotencyKey,
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    },
    new Date(now.getTime() - 500),
  );
  return admitted.permit;
}

async function executePublicationEffect(
  env: NativeEnv,
  permit: CommercialPermitRecord,
  publication: RecordCommercialPublicationInput & {
    externalEffectId: string;
  },
  now: Date,
): Promise<void> {
  await runExternalEffect(
    env,
    {
      effectId: publication.externalEffectId,
      tenantId: TENANT,
      actor: { type: "agent", id: "facet-projection-test-orchestrator" },
      taskId: `facet-projection:${publication.externalEffectId}`,
      authority: commercialEffectAuthority(permit),
      aggregate: {
        type: "proposal_publication",
        id: publication.proposalPackId,
        version: publication.publicationVersion,
      },
      intentId: publication.proposalRevisionId,
      action: "proposal.publish",
      request: { proposal_revision_id: publication.proposalRevisionId },
      provider: "customer-portal",
      providerAccountRef: "ironwrap-customer-portal",
      idempotencyKey: publication.externalEffectId,
      deadlineAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      preconditions: { quote_status: "approved" },
      evidenceRefs: EVIDENCE.map(({ ref }) => ref),
      expectedReadback: { state: "published" },
      // A proposal send runs once: D1 refuses any other retry limit for it (0164).
      retryLimit: 0,
      compensationPlan: { action: "proposal.withdraw" },
      correlationId: `correlation:${publication.externalEffectId}`,
    },
    {
      async dispatch() {
        return {
          outcome: "accepted" as const,
          value: { published: true },
          providerExternalId: `portal:${publication.externalEffectId}`,
          providerResponse: { state: "published" },
          readback: {
            status: "match" as const,
            observed: { state: "published" },
          },
        };
      },
      async replay() {
        return { published: true };
      },
    },
    now,
  );
}

function seedOperatingCore(db: DatabaseSync): void {
  const createdAt = "2027-01-15T06:00:00.000Z";
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, 'owner@example.invalid', 'Owner', 'owner', 'owner', NULL,
             1, 'test-fixture', ?, ?)`,
  ).run(OWNER, TENANT, createdAt, createdAt);
  // These contracts carry a deposit: the tenant takes deposits (MD-13), since 0155's default is OD-01.
  recordDepositPolicy(db, { tenantId: TENANT, ownerUserId: OWNER, at: createdAt });
  db.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, payload_json, raw_key,
      ts, status, created_at, updated_at)
     VALUES (?, 'website', 'Customer', ?, '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(
    ENVELOPE,
    CUSTOMER_EMAIL,
    "raw/facet-projection/0001.json",
    createdAt,
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO operating_leads
     (lead_id, tenant_id, source_envelope_id, source_raw_key, source,
      contact_name, contact_email, lifecycle_status, version, created_at,
      updated_at)
     VALUES (?, ?, ?, ?, 'website', 'Customer', ?, 'qualified', 1, ?, ?)`,
  ).run(
    LEAD,
    TENANT,
    ENVELOPE,
    "raw/facet-projection/0001.json",
    CUSTOMER_EMAIL,
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Customer', ?, 'active', 1, ?, ?)`,
  ).run(
    CUSTOMER,
    TENANT,
    ENVELOPE,
    "raw/facet-projection/0001.json",
    CUSTOMER_EMAIL,
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, property_id,
      source_envelope_id, source_raw_key, brand, service_type, job_status,
      current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'ironwrap', 'roof_replacement',
             'qualified', 'qualification', 1, ?, ?)`,
  ).run(
    JOB,
    TENANT,
    LEAD,
    CUSTOMER,
    ENVELOPE,
    "raw/facet-projection/0001.json",
    createdAt,
    createdAt,
  );
}

function seedAcceptedIntent(
  db: DatabaseSync,
  revisionNumber: number,
  termsHash: string,
  termsJson: string,
  proposalPackId: string,
  acceptedAt: Date,
  identityNumber = revisionNumber,
): void {
  const suffix = identityNumber.toString(16).padStart(16, "0");
  const portalLinkId = `portal_${suffix}`;
  const challengeId = `acceptance_challenge_${suffix}`;
  const accepted = acceptedAt.toISOString();
  db.prepare(
    `INSERT INTO customer_portal_links
     (link_id, token_hash, tenant_id, roof_job_id, customer_id,
      issued_by_user_id, created_at, expires_at, issued_ip_hash,
      issued_user_agent_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    portalLinkId,
    sha256(`portal-token-${identityNumber}`),
    TENANT,
    JOB,
    CUSTOMER,
    OWNER,
    new Date(acceptedAt.getTime() - 20 * 60_000).toISOString(),
    new Date(acceptedAt.getTime() + 24 * 60 * 60_000).toISOString(),
    sha256(`portal-ip-${identityNumber}`),
    sha256(`portal-user-agent-${identityNumber}`),
  );
  db.prepare(
    `INSERT INTO customer_portal_acceptance_challenges
     (challenge_id, token_hash, tenant_id, portal_link_id, roof_job_id,
      customer_id, email_hash, quote_id, quote_version, proposal_pack_id,
      terms_hash, terms_json, request_ip_hash, request_user_agent_hash, state,
      created_at, expires_at, sent_at, provider_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?)`,
  ).run(
    challengeId,
    sha256(`challenge-token-${identityNumber}`),
    TENANT,
    portalLinkId,
    JOB,
    CUSTOMER,
    sha256(CUSTOMER_EMAIL),
    QUOTE,
    revisionNumber,
    proposalPackId,
    termsHash,
    termsJson,
    sha256(`challenge-ip-${identityNumber}`),
    sha256(`challenge-user-agent-${identityNumber}`),
    new Date(acceptedAt.getTime() - 10 * 60_000).toISOString(),
    new Date(acceptedAt.getTime() + 60 * 60_000).toISOString(),
    new Date(acceptedAt.getTime() - 9 * 60_000).toISOString(),
    `message:${suffix}`,
  );
  db.prepare(
    `INSERT INTO customer_portal_acceptance_intents
     (acceptance_id, idempotency_key_hash, request_fingerprint, challenge_id,
      tenant_id, portal_link_id, roof_job_id, customer_id, email_hash, quote_id,
      quote_version, proposal_pack_id, terms_hash, terms_json, signer_name,
      signer_ip_hash, accepted_at, receipt_key, receipt_hash,
      receipt_content_length, state, frappe_attempted_at,
      frappe_attempt_lease_expires_at, result_json, response_status, error_code,
      created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Customer', ?, ?, ?, ?,
             512, 'accepted', ?, NULL, '{"accepted":true}', 200, NULL, ?, ?, ?)`,
  ).run(
    acceptanceId(identityNumber),
    sha256(`acceptance-idempotency-${identityNumber}`),
    sha256(`acceptance-request-${identityNumber}`),
    challengeId,
    TENANT,
    portalLinkId,
    JOB,
    CUSTOMER,
    sha256(CUSTOMER_EMAIL),
    QUOTE,
    revisionNumber,
    proposalPackId,
    termsHash,
    termsJson,
    sha256(`signer-ip-${identityNumber}`),
    accepted,
    `customer-contract-acceptance/v1/${sha256(`receipt-${identityNumber}`)}.json`,
    sha256(`receipt-body-${identityNumber}`),
    new Date(acceptedAt.getTime() + 30_000).toISOString(),
    new Date(acceptedAt.getTime() - 60_000).toISOString(),
    new Date(acceptedAt.getTime() + 30_000).toISOString(),
    new Date(acceptedAt.getTime() + 30_000).toISOString(),
  );
}

function quoteRevision(revisionNumber: number): string {
  return `quote-revision:facet-projection:${revisionNumber.toString().padStart(4, "0")}`;
}

function proposalRevision(revisionNumber: number): string {
  return `proposal-revision:facet-projection:${revisionNumber.toString().padStart(4, "0")}`;
}

function proposalPack(revisionNumber: number): string {
  return `proposal-pack:facet-projection:${revisionNumber.toString().padStart(4, "0")}`;
}

function acceptanceId(revisionNumber: number): string {
  return `acceptance_${revisionNumber.toString(16).padStart(16, "0")}`;
}

function quoteTime(revisionNumber: number): Date {
  return revisionNumber === 1
    ? new Date("2027-01-15T07:00:00.000Z")
    : new Date(
        Date.parse("2027-01-15T09:00:00.000Z") +
          (revisionNumber - 2) * 60 * 60_000,
      );
}

function chainTime(revisionNumber: number, offsetMinutes: number): Date {
  return new Date(quoteTime(revisionNumber).getTime() + offsetMinutes * 60_000);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compatibilityProvider(options: {
  beforeResponse?: () => Promise<void> | void;
  crash?: boolean;
  drift?: boolean;
  eventIdempotent?: boolean;
  rawResponse?: string;
  transformResponse?: (response: Record<string, unknown>) => Record<string, unknown>;
} = {}): {
  fetch: typeof fetch;
  calls: () => number;
  claims: () => Array<Record<string, unknown>>;
  correlationHeaders: () => Array<Record<string, string | null>>;
} {
  let callCount = 0;
  const captured: Array<Record<string, unknown>> = [];
  const capturedHeaders: Array<Record<string, string | null>> = [];
  const seenEvents = new Set<string>();
  return {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      if (options.crash) throw new Error("synthetic_provider_crash");
      const body = JSON.parse(String(init?.body)) as { facet_claim_json: string };
      const claim = JSON.parse(body.facet_claim_json) as Record<string, unknown>;
      captured.push(claim);
      const headers = new Headers(init?.headers);
      capturedHeaders.push({
        request_id: headers.get("x-request-id"),
        correlation_id: headers.get("x-correlation-id"),
        envelope_id: headers.get("x-ironwrap-envelope-id"),
      });
      await options.beforeResponse?.();
      const eventId = String(claim.event_id);
      const idempotentReplay = options.eventIdempotent === true && seenEvents.has(eventId);
      seenEvents.add(eventId);
      if (options.rawResponse !== undefined) {
        return new Response(options.rawResponse, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const response = options.transformResponse?.(
        compatibilityResponse(claim, options.drift ?? false, idempotentReplay),
      ) ?? compatibilityResponse(claim, options.drift ?? false, idempotentReplay);
      return new Response(JSON.stringify({ message: response }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    calls: () => callCount,
    claims: () => captured,
    correlationHeaders: () => capturedHeaders,
  };
}

function compatibilityResponse(
  claim: Record<string, unknown>,
  drift: boolean,
  idempotentReplay = false,
): Record<string, unknown> {
  const eventId = String(claim.event_id);
  const eventHash = sha256(eventId);
  const active = claim.decision_kind === "approved" || claim.decision_kind === "corrected";
  const previousEventId = String(claim.previous_event_id ?? eventId);
  const draftId = `facet-quote-revision:${sha256(active ? eventId : previousEventId)}`;
  const draftVersion = active ? 2 : 1;
  const evidenceId = `facet-design:${eventHash}`;
  const reconciliationId = `facet-design-projection:${eventHash}`;
  const receipt = {
    actor_identity_assurance: "oidc",
    approval_receipt_sha256: claim.approval_receipt_sha256,
    association_sha256: claim.association_sha256,
    blank_commercial_revision: active,
    claim_sha256: sha256(canonicalJson(claim)),
    customer_safe: false,
    decision_kind: claim.decision_kind,
    design_revision_id: claim.design_revision_id,
    design_revision_sha256: claim.design_revision_sha256,
    destination_tenant_id: claim.destination_tenant_id,
    draft_customer_quote_id: draftId,
    draft_quote_status: active ? "Draft" : "Rejected",
    draft_quote_version: draftVersion,
    event_id: eventId,
    event_type: "facet.design.customer_approved.v2",
    evidence_id: evidenceId,
    facet_project_id: claim.facet_project_id,
    frozen_evidence_sha256: claim.frozen_evidence_sha256,
    idempotent_replay: idempotentReplay,
    occurred_at: claim.occurred_at,
    raw_content_length: claim.raw_content_length,
    raw_key: claim.raw_key,
    raw_sha256: claim.raw_sha256,
    received_at: claim.received_at,
    reconciliation_id: reconciliationId,
    roof_job_id: claim.roof_job_id,
    schema: "ironwrap.facet-design-projection-receipt.v2",
    schema_version: 2,
    source_customer_quote_id: claim.customer_quote_id,
  };
  const receiptSha256 = sha256(canonicalJson(receipt));
  const receiptSignature = createHmac("sha256", HMAC_KEY)
    .update(`ironwrap.facet-design-projection.receipt.v2\n${receiptSha256}`)
    .digest("base64url");
  return {
    draft_customer_quote_id: draftId,
    draft_quote_version: draftVersion,
    event_id: eventId,
    evidence_id: drift ? `${evidenceId}-drift` : evidenceId,
    idempotent_replay: idempotentReplay,
    receipt,
    receipt_sha256: receiptSha256,
    receipt_signature: receiptSignature,
    receipt_signature_algorithm: "HMAC-SHA256",
    reconciliation_id: reconciliationId,
  };
}

test("compatibility projection sends the exact signed claim and accepts the signed blank-Draft receipt", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  await reconcileFacetDesignNativeProjections(env);
  env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  const provider = compatibilityProvider();
  try {
    const results = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.outcome, "succeeded");
    assert.equal(results[0]?.draftCustomerQuoteId, `facet-quote-revision:${sha256(EVENT)}`);
    assert.equal(results[0]?.draftQuoteVersion, 2);
    assert.equal(results[0]?.receipt?.blank_commercial_revision, true);
    assert.deepEqual(Object.keys(provider.claims()[0] ?? {}).sort(), [
      "approval_receipt_id", "approval_receipt_sha256", "association_sha256", "brand_id",
      "customer_party_ref", "customer_quote_id", "decision_kind", "design_revision_id",
      "design_revision_sha256", "destination_tenant_id", "event_id", "event_type",
      "external_customer_identity_link_id", "external_project_link_id", "facet_project_id",
      "frozen_evidence_sha256", "identity_assurance", "occurred_at", "oidc_issuer",
      "oidc_subject_sha256", "previous_event_id", "producer_identity_link_id",
      "raw_content_length", "raw_key", "raw_sha256", "reason_sha256", "received_at",
      "roof_job_id", "schema_version", "source_environment", "source_issuer", "source_tenant_id",
    ].sort());
    assert.deepEqual(provider.correlationHeaders(), [{
      request_id: EVENT,
      correlation_id: EVENT,
      envelope_id: EVENT,
    }]);
    assert.equal(provider.calls(), 1);
    const effect = db.raw
      .prepare("SELECT state, provider_external_id FROM external_effects WHERE provider = ? AND intent_id = ?")
      .get("frappe-facet-design", EVENT) as { state: string; provider_external_id: string };
    assert.equal(effect.state, "succeeded");
    assert.equal(effect.provider_external_id, `facet-design-projection:${sha256(EVENT)}`);
    const replay = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(replay, []);
    assert.equal(provider.calls(), 1);
  } finally {
    db.close();
  }
});

test("compatibility projection keeps crash ambiguity unknown and never re-dispatches it as success", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  await reconcileFacetDesignNativeProjections(env);
  env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  const crashing = compatibilityProvider({ crash: true });
  try {
    const first = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: crashing.fetch });
    assert.equal(first[0]?.outcome, "uncertain");
    assert.equal(first[0]?.errorCode, "effect_dispatch_unknown");
    assert.equal(crashing.calls(), 1);
    const succeeding = compatibilityProvider();
    const retry = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: succeeding.fetch });
    assert.deepEqual(retry, []);
    assert.equal(succeeding.calls(), 0);
    const state = db.raw
      .prepare("SELECT state FROM external_effects WHERE provider = ?")
      .get("frappe-facet-design") as { state: string };
    assert.equal(state.state, "unknown");
  } finally {
    db.close();
  }
});

test("compatibility projection recovers a pre-seeded decision chain oldest-first and replays without redispatch", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  seedDecision(db, {
    eventId: CORRECTION,
    decision: "corrected",
    previousEventId: EVENT,
    occurredAt: "2027-01-15T08:12:00.000Z",
  });
  seedDecision(db, {
    eventId: TERMINAL,
    decision: "withdrawn",
    previousEventId: CORRECTION,
    occurredAt: "2027-01-15T08:13:00.000Z",
  });
  await reconcileFacetDesignNativeProjections(env);
  env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  const provider = compatibilityProvider();
  try {
    const first = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(first.map((item) => item.eventId), [EVENT, CORRECTION, TERMINAL]);
    assert.deepEqual(first.map((item) => item.outcome), ["succeeded", "succeeded", "succeeded"]);
    assert.deepEqual(provider.claims().map((claim) => [claim.event_id, claim.decision_kind, claim.previous_event_id]), [
      [EVENT, "approved", null],
      [CORRECTION, "corrected", EVENT],
      [TERMINAL, "withdrawn", CORRECTION],
    ]);
    assert.equal(provider.calls(), 3);
    assert.equal(first[2]?.receipt?.draft_quote_status, "Rejected");
    assert.equal(first[2]?.draftCustomerQuoteId, `facet-quote-revision:${sha256(CORRECTION)}`);
    const replay = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(replay, []);
    assert.equal(provider.calls(), 3);
  } finally {
    db.close();
  }
});

test("compatibility projection bounds one expanded chain and resumes from its durable succeeded prefix", async () => {
  const { db, env } = await fixture();
  const chain = seedDecisionChain(db, 30);
  await reconcileFacetDesignNativeProjections(env);
  env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  const provider = compatibilityProvider();
  try {
    const first = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(first.map((item) => item.eventId), chain.slice(0, 25));
    assert.ok(first.every((item) => item.outcome === "succeeded"));
    assert.equal(first.length, 25);
    assert.equal(provider.calls(), 25);

    const second = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(second.map((item) => item.eventId), chain.slice(25));
    assert.ok(second.every((item) => item.outcome === "succeeded"));
    assert.equal(second.length, 5);
    assert.equal(provider.calls(), 30);
    assert.deepEqual(
      provider.claims().map((claim) => [claim.event_id, claim.previous_event_id]),
      chain.map((eventId, index) => [eventId, index === 0 ? null : chain[index - 1]]),
    );

    const third = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(third, []);
    assert.equal(provider.calls(), 30);
  } finally {
    db.close();
  }
});

test("compatibility projection never skips a manual predecessor after a durable succeeded prefix", async () => {
  const { db, env } = await fixture();
  const chain = seedDecisionChain(db, 60);
  await reconcileFacetDesignNativeProjections(env);
  const later = seedIndependentProjectedHead(db, 90, {
    occurredAt: "2027-01-15T08:30:00.000Z",
    projectionTemplateEventId: chain.at(-1),
  });
  env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  let responseNumber = 0;
  const provider = compatibilityProvider({
    transformResponse(response) {
      responseNumber += 1;
      if (responseNumber !== 25) return response;
      const malformed = { ...response };
      delete malformed.receipt_signature;
      return malformed;
    },
  });
  try {
    const first = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.equal(first.length, 25);
    assert.ok(first.slice(0, 24).every((item) => item.outcome === "succeeded"));
    assert.equal(first[24]?.eventId, chain[24]);
    assert.equal(first[24]?.outcome, "uncertain");
    assert.equal(first[24]?.errorCode, "frappe_projection_receipt_fields");
    assert.equal(provider.calls(), 25);
    const manual = db.raw.prepare(
      `SELECT state, result_code FROM external_effects
        WHERE action = 'facet.design.v2.compatibility_projection'
          AND intent_id = ?`,
    ).get(chain[24]) as { state: string; result_code: string };
    assert.equal(manual.state, "manual_exception");
    assert.equal(manual.result_code, "frappe_projection_receipt_fields");

    const second = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(second.map((item) => item.eventId), [chain[24], later]);
    assert.notEqual(second[0]?.outcome, "succeeded");
    assert.equal(second[1]?.outcome, "succeeded");
    assert.equal(second.length, 2);
    assert.equal(provider.calls(), 26);
    assert.equal(provider.claims().at(-1)?.event_id, later);
    assert.ok(provider.claims().every((claim) => !chain.slice(25).includes(String(claim.event_id))));

    const third = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(third.map((item) => item.eventId), [chain[24]]);
    assert.notEqual(third[0]?.outcome, "succeeded");
    assert.equal(provider.calls(), 26);
  } finally {
    db.close();
  }
});

test("compatibility projection incrementally replays prior events while projecting each new native head", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  await reconcileFacetDesignNativeProjections(env);
  env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  const provider = compatibilityProvider({ eventIdempotent: true });
  const effectRows = () => db.raw
    .prepare(
      `SELECT effect_id, idempotency_key
         FROM external_effects
        WHERE provider = ?
        ORDER BY idempotency_key`,
    )
    .all("frappe-facet-design") as Array<{ effect_id: string; idempotency_key: string }>;
  try {
    const first = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(first.map((item) => item.eventId), [EVENT]);
    assert.deepEqual(first.map((item) => item.outcome), ["succeeded"]);
    assert.deepEqual(first.map((item) => item.idempotentReplay), [false]);
    assert.equal(provider.calls(), 1);

    seedDecision(db, {
      eventId: CORRECTION,
      decision: "corrected",
      previousEventId: EVENT,
      occurredAt: "2027-01-15T08:12:00.000Z",
    });
    await reconcileFacetDesignNativeProjections(env, new Date("2027-01-15T08:12:30.000Z"));
    const second = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(second.map((item) => item.eventId), [EVENT, CORRECTION]);
    assert.deepEqual(second.map((item) => item.outcome), ["succeeded", "succeeded"]);
    assert.deepEqual(second.map((item) => item.idempotentReplay), [true, false]);
    assert.equal(provider.calls(), 3);
    assert.deepEqual(effectRows().map((row) => row.idempotency_key), [
      `facet-design-frappe-v2:${EVENT}:${EVENT}`,
      `facet-design-frappe-v2:${CORRECTION}:${CORRECTION}`,
      `facet-design-frappe-v2:${EVENT}:${CORRECTION}`,
    ].sort());

    seedDecision(db, {
      eventId: TERMINAL,
      decision: "withdrawn",
      previousEventId: CORRECTION,
      occurredAt: "2027-01-15T08:13:00.000Z",
    });
    await reconcileFacetDesignNativeProjections(env, new Date("2027-01-15T08:13:30.000Z"));
    const third = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(third.map((item) => item.eventId), [EVENT, CORRECTION, TERMINAL]);
    assert.deepEqual(third.map((item) => item.outcome), ["succeeded", "succeeded", "succeeded"]);
    assert.deepEqual(third.map((item) => item.idempotentReplay), [true, true, false]);
    assert.equal(provider.calls(), 6);
    assert.equal(effectRows().length, 6);
    assert.equal(new Set(effectRows().map((row) => row.effect_id)).size, 6);

    const replay = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(replay, []);
    assert.equal(provider.calls(), 6);
  } finally {
    db.close();
  }
});

test("compatibility projection holds a chain successor when its predecessor is unprojected", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  seedDecision(db, {
    eventId: CORRECTION,
    decision: "corrected",
    previousEventId: EVENT,
    occurredAt: "2027-01-15T08:12:00.000Z",
  });
  seedDecision(db, {
    eventId: TERMINAL,
    decision: "withdrawn",
    previousEventId: CORRECTION,
    occurredAt: "2027-01-15T08:13:00.000Z",
  });
  await reconcileFacetDesignNativeProjections(env);
  env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  const crashing = compatibilityProvider({ crash: true });
  try {
    const first = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: crashing.fetch });
    assert.deepEqual(first.map((item) => item.eventId), [EVENT, CORRECTION, TERMINAL]);
    assert.equal(first[0]?.errorCode, "effect_dispatch_unknown");
    assert.equal(first[1]?.errorCode, "facet_frappe_predecessor_unprojected");
    assert.equal(first[2]?.errorCode, "facet_frappe_predecessor_unprojected");
    assert.equal(crashing.calls(), 1);
    const blocked = db.raw.prepare(
      `SELECT effect_id, intent_id, state, result_code, exception_ref
         FROM external_effects
        WHERE action = 'facet.design.v2.compatibility_projection.blocked'
        ORDER BY intent_id`,
    ).all() as Array<Record<string, string>>;
    assert.deepEqual(blocked.map((effect) => [
      effect.intent_id,
      effect.state,
      effect.result_code,
      Boolean(effect.exception_ref),
    ]), [
      [TERMINAL, "manual_exception", "facet_frappe_predecessor_unprojected", true],
      [CORRECTION, "manual_exception", "facet_frappe_predecessor_unprojected", true],
    ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
    const succeeding = compatibilityProvider();
    const retry = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: succeeding.fetch });
    assert.deepEqual(retry.map((item) => item.eventId), [EVENT]);
    assert.equal(retry[0]?.errorCode, "effect_unknown_requires_reconciliation");
    assert.equal(succeeding.calls(), 0);
    assert.equal(
      Number((db.raw.prepare(
        `SELECT COUNT(*) AS count FROM external_effect_exceptions
          WHERE effect_id IN (
            SELECT effect_id FROM external_effects
             WHERE action = 'facet.design.v2.compatibility_projection.blocked'
          )`,
      ).get() as { count: number }).count),
      2,
    );
  } finally {
    db.close();
  }
});

test("unverifiable HTTP-200 receipts stay unknown without redispatch and withdrawal rejects its predecessor", async () => {
  const drifted = await fixture();
  seedDecision(drifted.db);
  await reconcileFacetDesignNativeProjections(drifted.env);
  drifted.env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  drifted.env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  const driftProvider = compatibilityProvider({ drift: true });
  try {
    const result = await reconcileFacetDesignFrappeProjections(drifted.env, NOW, { fetch: driftProvider.fetch });
    assert.equal(result[0]?.outcome, "uncertain");
    assert.equal(result[0]?.errorCode, "frappe_projection_receipt_identity_drift");
    const driftEffect = drifted.db.raw.prepare(
      "SELECT state, exception_ref FROM external_effects WHERE provider = ?",
    ).get("frappe-facet-design") as { state: string; exception_ref: string };
    assert.equal(driftEffect.state, "manual_exception");
    assert.ok(driftEffect.exception_ref);
    const succeeding = compatibilityProvider();
    const replay = await reconcileFacetDesignFrappeProjections(drifted.env, NOW, { fetch: succeeding.fetch });
    assert.deepEqual(replay, []);
    assert.equal(succeeding.calls(), 0);
  } finally {
    drifted.db.close();
  }

  const withdrawn = await fixture();
  seedDecision(withdrawn.db);
  seedDecision(withdrawn.db, {
    eventId: TERMINAL,
    decision: "withdrawn",
    previousEventId: EVENT,
    occurredAt: "2027-01-15T08:12:00.000Z",
  });
  await reconcileFacetDesignNativeProjections(withdrawn.env);
  withdrawn.env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  withdrawn.env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  const terminalProvider = compatibilityProvider();
  try {
    const result = await reconcileFacetDesignFrappeProjections(withdrawn.env, NOW, { fetch: terminalProvider.fetch });
    const terminal = result.find((item) => item.eventId === TERMINAL);
    assert.equal(result.map((item) => item.eventId).join(","), `${EVENT},${TERMINAL}`);
    assert.equal(terminal?.outcome, "succeeded");
    assert.equal(terminal?.decisionKind, "withdrawn");
    assert.equal(terminal?.draftCustomerQuoteId, `facet-quote-revision:${sha256(EVENT)}`);
    assert.equal(terminal?.receipt?.draft_quote_status, "Rejected");
    assert.equal(terminal?.receipt?.blank_commercial_revision, false);
    assert.deepEqual(terminalProvider.claims().map((claim) => claim.decision_kind), ["approved", "withdrawn"]);
    assert.equal((withdrawn.db.raw.prepare("SELECT COUNT(*) AS count FROM commercial_quote_revisions").get() as { count: number }).count, 1);
  } finally {
    withdrawn.db.close();
  }
});

test("malformed and unsigned HTTP-200 receipts require explicit reconciliation", async () => {
  const variants: Array<{
    code: string;
    rawResponse?: string;
    transformResponse?: (response: Record<string, unknown>) => Record<string, unknown>;
  }> = [
    {
      code: "frappe_projection_receipt_invalid_json",
      rawResponse: "not-json",
    },
    {
      code: "frappe_projection_receipt_too_large",
      rawResponse: "x".repeat(65 * 1024),
    },
    {
      code: "frappe_projection_receipt_shape",
      transformResponse: () => [] as unknown as Record<string, unknown>,
    },
    {
      code: "frappe_projection_receipt_signature_invalid",
      transformResponse: (response: Record<string, unknown>) => ({
        ...response,
        receipt_signature: "unsigned",
      }),
    },
  ];
  for (const variant of variants) {
    const { db, env } = await fixture();
    seedDecision(db);
    await reconcileFacetDesignNativeProjections(env);
    env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
    env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
    const provider = compatibilityProvider({
      rawResponse: variant.rawResponse,
      transformResponse: variant.transformResponse,
    });
    try {
      const first = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
      assert.equal(first[0]?.outcome, "uncertain");
      assert.equal(first[0]?.errorCode, variant.code);
      assert.equal(provider.calls(), 1);
      const succeeding = compatibilityProvider();
      const replay = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: succeeding.fetch });
      assert.deepEqual(replay, []);
      assert.equal(succeeding.calls(), 0);
      const effect = db.raw.prepare(
        `SELECT effect_id, state, result_code, exception_ref FROM external_effects
          WHERE provider = 'frappe-facet-design' AND intent_id = ?`,
      ).get(EVENT) as {
        effect_id: string;
        state: string;
        result_code: string;
        exception_ref: string;
      };
      assert.equal(effect.state, "manual_exception");
      assert.equal(effect.result_code, variant.code);
      assert.ok(effect.exception_ref);
      assert.equal(
        Number((db.raw.prepare(
          "SELECT COUNT(*) AS count FROM external_effect_exceptions WHERE effect_id = ?",
        ).get(effect.effect_id) as { count: number }).count),
        1,
      );
    } finally {
      db.close();
    }
  }
});

test("historical Frappe success cannot bypass revoked or changed commercial authority", async () => {
  for (const drift of ["revoked_link", "commercial_revision"] as const) {
    const { db, env } = await fixture();
    seedDecision(db);
    await reconcileFacetDesignNativeProjections(env);
    env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
    env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
    const provider = compatibilityProvider();
    try {
      const success = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
      assert.equal(success[0]?.outcome, "succeeded");
      assert.equal(provider.calls(), 1);
      if (drift === "revoked_link") {
        const link = db.raw.prepare(
          "SELECT external_project_link_id FROM facet_v2_project_links WHERE facet_project_id = ?",
        ).get(PROJECT) as { external_project_link_id: string };
        db.raw.prepare(
          `INSERT INTO facet_v2_link_revocations
           (revocation_id, link_kind, link_id, reason_code, revoked_by_user_id,
            destination_tenant_id, revoked_at)
           VALUES ('facet-frappe-success-revocation', 'project', ?,
                   'customer_request', ?, ?, '2027-01-15T08:30:00.000Z')`,
        ).run(link.external_project_link_id, OWNER, TENANT);
      } else {
        await seedNativeAcceptedContract(db, env, 2);
      }
      const afterDrift = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
      assert.equal(afterDrift[0]?.outcome, "uncertain");
      assert.equal(afterDrift[0]?.errorCode, "facet_frappe_current_authority_drift");
      assert.equal(provider.calls(), 1);
      const blocked = db.raw.prepare(
        `SELECT effect_id, state, result_code, exception_ref, evidence_refs_json
           FROM external_effects
          WHERE action = 'facet.design.v2.compatibility_projection.blocked'
            AND intent_id = ?`,
      ).get(EVENT) as Record<string, string>;
      assert.equal(blocked.state, "manual_exception");
      assert.equal(blocked.result_code, "facet_frappe_current_authority_drift");
      assert.ok(blocked.exception_ref);
      assert.match(blocked.evidence_refs_json, /facet-v2:event:/);
      assert.match(blocked.evidence_refs_json, /facet-native-design:/);
      const replay = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
      assert.deepEqual(replay, []);
      assert.equal(provider.calls(), 1);
      assert.equal(
        Number((db.raw.prepare(
          "SELECT COUNT(*) AS count FROM external_effect_exceptions WHERE effect_id = ?",
        ).get(blocked.effect_id) as { count: number }).count),
        1,
      );
    } finally {
      db.close();
    }
  }
});

test("terminal current heads advance a bounded recovery window beyond 25 and an invalid oldest head cannot starve later work", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  await reconcileFacetDesignNativeProjections(env);
  const invalid = seedIndependentProjectedHead(db, 1, {
    decision: "corrected",
    previousEventId: EVENT,
    occurredAt: "2027-01-15T08:05:00.000Z",
  });
  const valid = Array.from({ length: 25 }, (_, index) =>
    seedIndependentProjectedHead(db, index + 2));
  env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  const provider = compatibilityProvider();
  try {
    const first = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.equal(first.length, 25);
    assert.equal(first[0]?.eventId, invalid);
    assert.equal(first[0]?.errorCode, "facet_frappe_predecessor_chain_invalid");
    assert.equal(provider.calls(), 24);
    const second = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(second.map((item) => item.eventId), [valid.at(-1)]);
    assert.equal(second[0]?.outcome, "succeeded");
    assert.equal(provider.calls(), 25);
    const third = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(third, []);
    assert.equal(provider.calls(), 25);
    const blocked = db.raw.prepare(
      `SELECT effect_id, state, exception_ref FROM external_effects
        WHERE action = 'facet.design.v2.compatibility_projection.blocked'
          AND intent_id = ?`,
    ).get(invalid) as { effect_id: string; state: string; exception_ref: string };
    assert.equal(blocked.state, "manual_exception");
    assert.ok(blocked.exception_ref);
    assert.equal(
      Number((db.raw.prepare(
        "SELECT COUNT(*) AS count FROM external_effect_events WHERE effect_id = ?",
      ).get(blocked.effect_id) as { count: number }).count),
        4,
    );
  } finally {
    db.close();
  }
});

test("request validation failures persist one deterministic pre-dispatch exception", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  await reconcileFacetDesignNativeProjections(env);
  env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  const initial = compatibilityProvider();
  await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: initial.fetch });
  const invalid = seedIndependentProjectedHead(db, 1, {
    occurredAt: "2027-01-15T08:20:00.000Z",
    receivedAt: "2027-01-15T08:19:00.000Z",
  });
  const provider = compatibilityProvider();
  try {
    const first = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.eventId, invalid);
    assert.equal(first[0]?.outcome, "uncertain");
    assert.equal(first[0]?.errorCode, "facet_v2_native_authority_drift");
    assert.equal(provider.calls(), 0);
    const blocked = db.raw.prepare(
      `SELECT effect_id, state, result_code, exception_ref
         FROM external_effects
        WHERE action = 'facet.design.v2.compatibility_projection.blocked'
          AND intent_id = ?`,
    ).get(invalid) as Record<string, string>;
    assert.equal(blocked.state, "manual_exception");
    assert.equal(blocked.result_code, "facet_v2_native_authority_drift");
    const replay = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.deepEqual(replay, []);
    assert.equal(provider.calls(), 0);
    assert.equal(
      Number((db.raw.prepare(
        "SELECT COUNT(*) AS count FROM external_effect_exceptions WHERE effect_id = ?",
      ).get(blocked.effect_id) as { count: number }).count),
      1,
    );
  } finally {
    db.close();
  }
});

test("compatibility projection opens manual reconciliation when the native head drifts after dispatch", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  await reconcileFacetDesignNativeProjections(env);
  env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED = "true";
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = HMAC_KEY;
  let raced = false;
  const provider = compatibilityProvider({
    beforeResponse: async () => {
      if (raced) return;
      raced = true;
      seedDecision(db, {
        eventId: CORRECTION,
        decision: "corrected",
        previousEventId: EVENT,
        occurredAt: "2027-01-15T08:12:00.000Z",
      });
      await reconcileFacetDesignNativeProjections(
        env,
        new Date("2027-01-15T08:12:30.000Z"),
      );
    },
  });
  try {
    const result = await reconcileFacetDesignFrappeProjections(env, NOW, { fetch: provider.fetch });
    assert.equal(result[0]?.outcome, "uncertain");
    assert.equal(result[0]?.errorCode, "facet_v2_native_authority_drift_after_dispatch");
    const effect = db.raw
      .prepare("SELECT state, result_code FROM external_effects WHERE provider = ? AND intent_id = ?")
      .get("frappe-facet-design", EVENT) as { state: string; result_code: string };
    assert.equal(effect.state, "manual_exception");
    assert.equal(effect.result_code, "facet_v2_native_authority_drift_after_dispatch");
    assert.equal(provider.calls(), 1);
  } finally {
    db.close();
  }
});

test("disabled compatibility projection is a no-op even when native D1 is present", async () => {
  const { db, env } = await fixture();
  seedDecision(db);
  await reconcileFacetDesignNativeProjections(env);
  const network = installNetworkTrap();
  try {
    const result = await reconcileFacetDesignFrappeProjections(env, NOW);
    assert.deepEqual(result, []);
    assert.equal(network.count(), 0);
  } finally {
    network.restore();
    db.close();
  }
});
