import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
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
import { issueFacetLaunch } from "../src/facet-launch.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";

const TENANT = "ironwrap";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OWNER = "owner-user-0001";
const ENVELOPE = "ow_facet_launch_0001";
const LEAD = "lead:facet-launch:0001";
const CUSTOMER = "CUSTOMER-1";
const JOB = "roof-job-1";
const QUOTE = "customer-quote-1";
const EVIDENCE = [
  { ref: "r2://facet-launch/evidence/0001.json", sha256: "a".repeat(64) },
] as const;
const TERMS = {
  deposit_percent: 25,
  payment_schedule: ["deposit", "completion"],
  payment_terms_days: 30,
  warranty_years: 10,
};
const KEY_BYTES = Buffer.from("synthetic-facet-launch-key-32bytes!", "utf8");
const KEY = KEY_BYTES.toString("base64url");
const NOW = new Date("2027-01-15T08:00:00.000Z");
const LAUNCH_FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/facet-v2-launch-roundtrip.json", import.meta.url),
    "utf8",
  ),
) as {
  key_base64url: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  expected: {
    token: string;
    envelope_sha256: string;
    producer_identity_link_id: string;
    external_project_link_id: string;
  };
};
const ROUTE = {
  version: 1,
  issuer: "facet",
  source_product: "facet",
  source_environment: "production",
  source_tenant_id: SOURCE,
  destination_tenant_id: TENANT,
  destination_url: "https://bus.example.invalid/ingest/facet-design",
};

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor(customerEmail: string | null = "customer@example.invalid") {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    }
    seedOperatingCore(this.raw, customerEmail);
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

  close(): void {
    this.raw.close();
  }
}

class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(raw: DatabaseSync, sql: string | StatementSync, args: unknown[]) {
    this.raw = raw;
    this.statement = typeof sql === "string" ? raw.prepare(sql) : sql;
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

  async run() {
    return this.execute();
  }

  execute() {
    const result = this.statement.run(...this.args);
    return {
      success: true as const,
      meta: { changes: Number(result.changes) },
    };
  }
}

function env(db: SqliteD1): AppEnv & {
  COMMERCIAL_AUTHORITY_POLICY_JSON: string;
} {
  return {
    DB: db as never,
    EFFECT_RUNTIME_ENABLED: "true",
    APP_FACET_LAUNCH_ENABLED: "true",
    APP_FACET_LAUNCH_BASE_URL: "https://facet.example.invalid/",
    APP_FACET_LAUNCH_SOURCE_TENANT_ID: SOURCE,
    FACET_LAUNCH_HMAC_KEY: KEY,
    FACET_V2_ROUTES_JSON: JSON.stringify([ROUTE]),
    COMMERCIAL_AUTHORITY_POLICY_JSON: JSON.stringify({
      schema_version: "ironwrap.commercial-authority-policy.v1",
      policy_id: "facet-launch-commercial-authority",
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
  } as AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string };
}

function auth(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: NOW.toISOString(),
      session_expires_at: "2027-01-15T20:00:00.000Z",
      revoked_at: null,
      user_id: role === "owner" ? OWNER : `${role}-user-0001`,
      tenant_id: TENANT,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.invalid`,
      active: 1,
      created_by: "test-fixture",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      device_id: null,
      device_proof_hash: null,
    },
  };
}

function installNetworkTrap() {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("facet_launch_network_forbidden");
  };
  return {
    count() {
      return calls;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

function tokenFrom(
  result: Awaited<ReturnType<typeof issueFacetLaunch>>,
): string {
  assert.notEqual(result.kind, "rejected");
  if (result.kind === "rejected") throw new Error("launch rejected");
  return new URL(result.launch.launch_url).hash.slice("#iwlaunch=".length);
}

function decoded(token: string, part: number): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[part]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

test("signed launch creates one exact durable authority and deterministic private replay", async () => {
  const db = new SqliteD1();
  const nativeEnv = env(db);
  await seedNativeAcceptedChain(nativeEnv, 3);
  const network = installNetworkTrap();
  try {
    const first = await issueFacetLaunch(nativeEnv, {
      tenantId: TENANT,
      jobName: JOB,
      actorUserId: OWNER,
      actorRole: "owner",
      idempotencyKey: "facet-launch:test-0001",
      now: NOW,
      projectId: PROJECT,
    });
    assert.equal(first.kind, "created");
    const token = tokenFrom(first);
    assert.equal(KEY, LAUNCH_FIXTURE.key_base64url);
    assert.equal(token, LAUNCH_FIXTURE.expected.token);
    const [encodedHeader, encodedPayload, signature] = token.split(".");
    assert.deepEqual(decoded(token, 0), LAUNCH_FIXTURE.header);
    const email = "customer@example.invalid";
    const customerPartyRef = sha256(
      `ironwrap.customer-party.email.v1\n${email}`,
    );
    const externalIdentity = `facet-customer-oidc-v1:${sha256(`facet.customer-oidc-email.v1\n${email}`)}`;
    assert.deepEqual(decoded(token, 1), LAUNCH_FIXTURE.payload);
    assert.equal(
      signature,
      createHmac("sha256", KEY_BYTES)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest("base64url"),
    );
    const envelopeSha256 = sha256(token);
    assert.equal(envelopeSha256, LAUNCH_FIXTURE.expected.envelope_sha256);
    const identity = db.raw
      .prepare(
        `SELECT producer_identity_link_id, destination_tenant_id, source_tenant_id,
              issuer, source_environment, proof_sha256
         FROM facet_v2_producer_identity_links`,
      )
      .get();
    assert.deepEqual(
      { ...identity! },
      {
        producer_identity_link_id:
          LAUNCH_FIXTURE.expected.producer_identity_link_id,
        destination_tenant_id: TENANT,
        source_tenant_id: SOURCE,
        issuer: "facet",
        source_environment: "production",
        proof_sha256: envelopeSha256,
      },
    );
    const project = db.raw
      .prepare(
        `SELECT external_project_link_id, customer_party_ref,
              external_customer_identity_link_id, roof_job_id,
              customer_quote_id, project_claim_sha256 FROM facet_v2_project_links`,
      )
      .get();
    assert.deepEqual(
      { ...project! },
      {
        external_project_link_id:
          LAUNCH_FIXTURE.expected.external_project_link_id,
        customer_party_ref: customerPartyRef,
        external_customer_identity_link_id: externalIdentity,
        roof_job_id: "roof-job-1",
        customer_quote_id: "customer-quote-1",
        project_claim_sha256: envelopeSha256,
      },
    );
    const persisted = JSON.stringify({
      identity,
      project,
      launch: db.raw.prepare("SELECT * FROM facet_v2_project_launches").get(),
    });
    assert.equal(persisted.includes(email), false);
    assert.equal(persisted.includes(token), false);

    const replay = await issueFacetLaunch(nativeEnv, {
      tenantId: TENANT,
      jobName: JOB,
      actorUserId: OWNER,
      actorRole: "owner",
      idempotencyKey: "facet-launch:test-0001",
    });
    assert.equal(replay.kind, "replayed");
    assert.equal(tokenFrom(replay), token);

    db.raw
      .prepare(
        `UPDATE operating_roof_jobs
            SET brand = 'iroof', version = version + 1, updated_at = ?
          WHERE tenant_id = ? AND roof_job_id = ?`,
      )
      .run("2027-01-15T08:01:00.000Z", TENANT, JOB);
    const secondBrandProject = "33333333-3333-4333-8333-333333333333";
    const secondBrand = await issueFacetLaunch(nativeEnv, {
      tenantId: TENANT,
      jobName: JOB,
      actorUserId: OWNER,
      actorRole: "owner",
      idempotencyKey: "facet-launch:test-iroof-0001",
      now: NOW,
      projectId: secondBrandProject,
    });
    assert.equal(secondBrand.kind, "created");
    assert.equal(decoded(tokenFrom(secondBrand), 1).brand_id, "iroof");
    assert.equal(
      Number(
        (
          db.raw
            .prepare(
              "SELECT COUNT(*) AS count FROM facet_v2_producer_identity_links",
            )
            .get() as { count: number }
        ).count,
      ),
      1,
    );
    const brandProjects = db.raw
      .prepare(
        "SELECT brand_id FROM facet_v2_project_links ORDER BY facet_project_id",
      )
      .all() as Array<{ brand_id: string }>;
    assert.deepEqual(brandProjects.map((row) => row.brand_id).sort(), [
      "ironwrap",
      "iroof",
    ]);
    db.raw
      .prepare(
        `UPDATE operating_roof_jobs
            SET brand = 'ironwrap', version = version + 1, updated_at = ?
          WHERE tenant_id = ? AND roof_job_id = ?`,
      )
      .run("2027-01-15T08:02:00.000Z", TENANT, JOB);

    const links = db.raw
      .prepare(
        `SELECT external_project_link_id, producer_identity_link_id,
                external_customer_identity_link_id
           FROM facet_v2_project_links
          WHERE facet_project_id = ?`,
      )
      .get(PROJECT) as Record<string, string>;
    db.raw
      .prepare(
        `INSERT INTO facet_v2_link_revocations
       (revocation_id, link_kind, link_id, reason_code, revoked_by_user_id,
        destination_tenant_id, revoked_at)
       VALUES ('revoke-launch-0001', 'project', ?, 'test_revocation', ?, ?, ?)`,
      )
      .run(
        links.external_project_link_id,
        OWNER,
        TENANT,
        "2027-01-15T08:02:30.000Z",
      );
    assert.deepEqual(
      await issueFacetLaunch(nativeEnv, {
        tenantId: TENANT,
        jobName: JOB,
        actorUserId: OWNER,
        actorRole: "owner",
        idempotencyKey: "facet-launch:test-0001",
      }),
      {
        kind: "rejected",
        code: "facet_launch_authority_collision",
        status: 409,
      },
    );

    await seedNativeAcceptedChain(nativeEnv, 4);
    assert.deepEqual(
      await issueFacetLaunch(nativeEnv, {
        tenantId: TENANT,
        jobName: JOB,
        actorUserId: OWNER,
        actorRole: "owner",
        idempotencyKey: "facet-launch:test-0001",
      }),
      {
        kind: "rejected",
        code: "facet_launch_idempotency_conflict",
        status: 409,
      },
    );
    const before = Number(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS count FROM facet_v2_project_launches")
          .get() as { count: number }
      ).count,
    );
    const collision = await issueFacetLaunch(nativeEnv, {
      tenantId: TENANT,
      jobName: JOB,
      actorUserId: OWNER,
      actorRole: "owner",
      idempotencyKey: "facet-launch:test-0002",
      now: NOW,
      projectId: PROJECT,
    });
    assert.deepEqual(collision, {
      kind: "rejected",
      code: "facet_launch_authority_collision",
      status: 409,
    });
    assert.equal(
      Number(
        (
          db.raw
            .prepare("SELECT COUNT(*) AS count FROM facet_v2_project_launches")
            .get() as { count: number }
        ).count,
      ),
      before,
    );

    assert.equal(network.count(), 0);
  } finally {
    network.restore();
    db.close();
  }
});

test("launch fails closed on role, route, tenant, chain, and customer identity drift", async () => {
  const db = new SqliteD1();
  const nativeEnv = env(db);
  await seedNativeAcceptedChain(nativeEnv, 3);
  const network = installNetworkTrap();
  try {
    const base = {
      tenantId: TENANT,
      jobName: JOB,
      actorUserId: OWNER,
      idempotencyKey: "facet-launch:negative-0001",
      now: NOW,
      projectId: PROJECT,
    };
    assert.deepEqual(
      await issueFacetLaunch(nativeEnv, { ...base, actorRole: "ops" }),
      {
        kind: "rejected",
        code: "facet_launch_owner_required",
        status: 403,
      },
    );
    assert.deepEqual(
      await issueFacetLaunch(
        {
          ...nativeEnv,
          APP_FACET_LAUNCH_SOURCE_TENANT_ID:
            "33333333-3333-4333-8333-333333333333",
        },
        { ...base, actorRole: "owner" },
      ),
      {
        kind: "rejected",
        code: "facet_launch_not_configured",
        status: 503,
      },
    );
    assert.deepEqual(
      await issueFacetLaunch(nativeEnv, {
        ...base,
        tenantId: "other-tenant",
        actorRole: "owner",
      }),
      {
        kind: "rejected",
        code: "facet_launch_not_configured",
        status: 503,
      },
    );

    const noChain = new SqliteD1();
    assert.deepEqual(
      await issueFacetLaunch(env(noChain), { ...base, actorRole: "owner" }),
      {
        kind: "rejected",
        code: "facet_design_current_approved_quote_required",
        status: 409,
      },
    );
    noChain.close();

    const noEmail = new SqliteD1(null);
    const noEmailEnv = env(noEmail);
    await seedNativeAcceptedChain(noEmailEnv, 3);
    assert.deepEqual(
      await issueFacetLaunch(noEmailEnv, { ...base, actorRole: "owner" }),
      {
        kind: "rejected",
        code: "facet_launch_customer_identity_required",
        status: 409,
      },
    );
    noEmail.close();
    assert.equal(network.count(), 0);
  } finally {
    network.restore();
    db.close();
  }
});

test("owner BFF launch route requires CSRF, exact empty body, and stable idempotency", async () => {
  const db = new SqliteD1();
  const nativeEnv = env(db);
  await seedNativeAcceptedChain(nativeEnv, 3);
  const network = installNetworkTrap();
  try {
    const request = (body: unknown, headers: Record<string, string> = {}) =>
      new Request(
        `https://app.example.invalid/api/v1/estimator/jobs/${JOB}/facet-launches`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        },
      );
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request(
            {},
            {
              "x-csrf-token": "csrf",
              "idempotency-key": "facet-launch:api-0001",
            },
          ),
          nativeEnv,
          auth("ops"),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request(
            {},
            {
              "idempotency-key": "facet-launch:api-0001",
            },
          ),
          nativeEnv,
          auth("owner"),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handleAuthenticatedRoute(
          request(
            { extra: true },
            {
              "x-csrf-token": "csrf",
              "idempotency-key": "facet-launch:api-0001",
            },
          ),
          nativeEnv,
          auth("owner"),
        )
      ).status,
      400,
    );
    const created = await handleAuthenticatedRoute(
      request(
        {},
        {
          "x-csrf-token": "csrf",
          "idempotency-key": "facet-launch:api-0001",
        },
      ),
      nativeEnv,
      auth("owner"),
    );
    assert.equal(created.status, 201);
    const payload = (await created.json()) as Record<string, unknown>;
    assert.deepEqual(payload.allowed_actions, ["facet_launch.create"]);
    assert.equal((payload.launch as Record<string, unknown>).state, "issued");
    const replay = await handleAuthenticatedRoute(
      request(
        {},
        {
          "x-csrf-token": "csrf",
          "idempotency-key": "facet-launch:api-0001",
        },
      ),
      nativeEnv,
      auth("owner"),
    );
    assert.equal(replay.status, 200);
    assert.equal(
      ((await replay.json()) as Record<string, unknown>).replayed,
      true,
    );
    assert.equal(network.count(), 0);
  } finally {
    network.restore();
    db.close();
  }
});

async function seedNativeAcceptedChain(
  nativeEnv: AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string },
  revisionNumber: number,
): Promise<void> {
  const db = nativeEnv.DB as unknown as SqliteD1;
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
      nativeEnv,
      "quote.revision.record",
      { type: "customer_quote", id: QUOTE, version: revision },
      prepared.command,
      `permit:facet-launch:quote:${revision}`,
      prepared.totalCents,
      at,
    );
    input.authority = { kind: "policy_permit", permitId: permit.permit_id };
    await recordCommercialQuoteRevision(nativeEnv, input, at);
  }

  const quoteRevisionId = quoteRevision(revisionNumber);
  const proposalInput = proposalRequest(revisionNumber, quoteRevisionId);
  const preparedProposal = await prepareCommercialProposal(proposalInput);
  const proposalAt = chainTime(revisionNumber, 10);
  const proposalPermit = await admitFor(
    nativeEnv,
    "proposal.revision.record",
    {
      type: "proposal",
      id: proposalInput.proposalPackId,
      version: proposalInput.revisionNumber,
    },
    preparedProposal.command,
    `permit:facet-launch:proposal:${revisionNumber}`,
    null,
    proposalAt,
  );
  proposalInput.authority = {
    kind: "policy_permit",
    permitId: proposalPermit.permit_id,
  };
  const proposal = await recordCommercialProposalRevision(
    nativeEnv,
    proposalInput,
    proposalAt,
  );

  const publicationInput = publicationRequest(
    revisionNumber,
    proposal.proposal.proposal_revision_id,
    proposal.proposal.proposal_pack_id,
  );
  const publicationAt = chainTime(revisionNumber, 20);
  const publicationPermit = await admitFor(
    nativeEnv,
    "proposal.publish",
    {
      type: "proposal_publication",
      id: publicationInput.proposalPackId,
      version: 1,
    },
    buildCommercialPublicationCommand(publicationInput),
    `permit:facet-launch:publication:${revisionNumber}`,
    null,
    chainTime(revisionNumber, 18),
  );
  publicationInput.authority = {
    kind: "policy_permit",
    permitId: publicationPermit.permit_id,
  };
  publicationInput.externalEffectId = `effect:facet-launch-publication:${revisionNumber}`;
  await executePublicationEffect(
    nativeEnv,
    publicationPermit,
    publicationInput,
    chainTime(revisionNumber, 19),
  );
  await recordCommercialProposalPublication(
    nativeEnv,
    publicationInput,
    publicationAt,
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
    nativeEnv,
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
        : `Customer-approved quote correction ${revisionNumber}.`,
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
    idempotencyKey: `facet-launch:quote:${revisionNumber}`,
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
    contentRef: `r2://facet-launch/proposal-${revisionNumber}.pdf`,
    contentHash: sha256(`proposal-content-${revisionNumber}`),
    evidence: EVIDENCE,
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: `facet-launch:proposal:${revisionNumber}`,
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
    idempotencyKey: `facet-launch:publication:${revisionNumber}`,
  };
}

async function admitFor(
  nativeEnv: AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON: string },
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
    nativeEnv,
    {
      tenantId: TENANT,
      actor: { type: "agent", id: "facet-launch-test-orchestrator" },
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
  nativeEnv: AppEnv,
  permit: CommercialPermitRecord,
  publication: RecordCommercialPublicationInput & {
    externalEffectId: string;
  },
  now: Date,
): Promise<void> {
  await runExternalEffect(
    nativeEnv,
    {
      effectId: publication.externalEffectId,
      tenantId: TENANT,
      actor: { type: "agent", id: "facet-launch-test-orchestrator" },
      taskId: `facet-launch:${publication.externalEffectId}`,
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
      retryLimit: 1,
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

function seedOperatingCore(
  db: DatabaseSync,
  customerEmail: string | null,
): void {
  const createdAt = "2027-01-15T06:00:00.000Z";
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, 'owner@example.invalid', 'Synthetic Owner', 'owner', NULL,
             1, 'test-fixture', ?, ?)`,
  ).run(OWNER, TENANT, createdAt, createdAt);
  db.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, contact_phone, payload_json,
      raw_key, ts, status, created_at, updated_at)
     VALUES (?, 'website', 'Customer', ?, ?, '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(
    ENVELOPE,
    customerEmail,
    customerEmail ? null : "+14035550199",
    "raw/facet-launch/0001.json",
    createdAt,
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO operating_leads
     (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
      contact_email, contact_phone, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'website', 'Customer', ?, ?, 'qualified', 1, ?, ?)`,
  ).run(
    LEAD,
    TENANT,
    ENVELOPE,
    "raw/facet-launch/0001.json",
    customerEmail,
    customerEmail ? null : "+14035550199",
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
      contact_email, contact_phone, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Customer', ?, ?, 'active', 1, ?, ?)`,
  ).run(
    CUSTOMER,
    TENANT,
    ENVELOPE,
    "raw/facet-launch/0001.json",
    customerEmail,
    customerEmail ? null : "+14035550199",
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, property_id,
      source_envelope_id, source_raw_key, brand, service_type, job_status,
      current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'ironwrap', 'roof_replacement', 'qualified',
             'qualification', 1, ?, ?)`,
  ).run(
    JOB,
    TENANT,
    LEAD,
    CUSTOMER,
    ENVELOPE,
    "raw/facet-launch/0001.json",
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
): void {
  const suffix = revisionNumber.toString(16).padStart(16, "0");
  const portalLinkId = `portal_${suffix}`;
  const challengeId = `acceptance_challenge_${suffix}`;
  const accepted = acceptedAt.toISOString();
  db.prepare(
    `INSERT INTO customer_portal_links (
       link_id, token_hash, tenant_id, roof_job_id, customer_id, issued_by_user_id,
       created_at, expires_at, issued_ip_hash, issued_user_agent_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    portalLinkId,
    sha256(`portal-token-${revisionNumber}`),
    TENANT,
    JOB,
    CUSTOMER,
    OWNER,
    new Date(acceptedAt.getTime() - 20 * 60_000).toISOString(),
    new Date(acceptedAt.getTime() + 24 * 60 * 60_000).toISOString(),
    sha256(`portal-ip-${revisionNumber}`),
    sha256(`portal-user-agent-${revisionNumber}`),
  );
  db.prepare(
    `INSERT INTO customer_portal_acceptance_challenges (
       challenge_id, token_hash, tenant_id, portal_link_id, roof_job_id,
       customer_id, email_hash, quote_id, quote_version, proposal_pack_id,
       terms_hash, terms_json, request_ip_hash, request_user_agent_hash, state,
       created_at, expires_at, sent_at, provider_message_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?)`,
  ).run(
    challengeId,
    sha256(`challenge-token-${revisionNumber}`),
    TENANT,
    portalLinkId,
    JOB,
    CUSTOMER,
    sha256("customer@example.invalid"),
    QUOTE,
    revisionNumber,
    proposalPackId,
    termsHash,
    termsJson,
    sha256(`challenge-ip-${revisionNumber}`),
    sha256(`challenge-user-agent-${revisionNumber}`),
    new Date(acceptedAt.getTime() - 10 * 60_000).toISOString(),
    new Date(acceptedAt.getTime() + 60 * 60_000).toISOString(),
    new Date(acceptedAt.getTime() - 9 * 60_000).toISOString(),
    `message:${suffix}`,
  );
  db.prepare(
    `INSERT INTO customer_portal_acceptance_intents (
       acceptance_id, idempotency_key_hash, request_fingerprint, challenge_id,
       tenant_id, portal_link_id, roof_job_id, customer_id, email_hash, quote_id,
       quote_version, proposal_pack_id, terms_hash, terms_json, signer_name,
       signer_ip_hash, accepted_at, receipt_key, receipt_hash,
       receipt_content_length, state, frappe_attempted_at,
       frappe_attempt_lease_expires_at, result_json, response_status, error_code,
       created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Customer', ?, ?, ?, ?,
               512, 'accepted', ?, NULL, '{"accepted":true}', 200, NULL, ?, ?, ?)`,
  ).run(
    acceptanceId(revisionNumber),
    sha256(`acceptance-idempotency-${revisionNumber}`),
    sha256(`acceptance-request-${revisionNumber}`),
    challengeId,
    TENANT,
    portalLinkId,
    JOB,
    CUSTOMER,
    sha256("customer@example.invalid"),
    QUOTE,
    revisionNumber,
    proposalPackId,
    termsHash,
    termsJson,
    sha256(`signer-ip-${revisionNumber}`),
    accepted,
    `customer-contract-acceptance/v1/${sha256(`receipt-${revisionNumber}`)}.json`,
    sha256(`receipt-body-${revisionNumber}`),
    new Date(acceptedAt.getTime() + 30_000).toISOString(),
    new Date(acceptedAt.getTime() - 60_000).toISOString(),
    new Date(acceptedAt.getTime() + 30_000).toISOString(),
    new Date(acceptedAt.getTime() + 30_000).toISOString(),
  );
}

function quoteRevision(revisionNumber: number): string {
  return `quote-revision:facet-launch:${revisionNumber.toString().padStart(4, "0")}`;
}

function proposalRevision(revisionNumber: number): string {
  return `proposal-revision:facet-launch:${revisionNumber.toString().padStart(4, "0")}`;
}

function proposalPack(revisionNumber: number): string {
  return `proposal-pack:facet-launch:${revisionNumber.toString().padStart(4, "0")}`;
}

function acceptanceId(revisionNumber: number): string {
  return `acceptance_${revisionNumber.toString(16).padStart(16, "0")}`;
}

function quoteTime(revisionNumber: number): Date {
  if (revisionNumber <= 3) {
    return new Date(
      Date.parse("2027-01-15T06:30:00.000Z") +
        (revisionNumber - 1) * 15 * 60_000,
    );
  }
  return new Date(
    Date.parse("2027-01-15T08:03:00.000Z") + (revisionNumber - 4) * 60 * 60_000,
  );
}

function chainTime(revisionNumber: number, offsetMinutes: number): Date {
  return new Date(quoteTime(revisionNumber).getTime() + offsetMinutes * 60_000);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
